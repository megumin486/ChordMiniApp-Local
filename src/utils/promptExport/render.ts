/**
 * Renders the prompt text from a Timeline plus metadata.
 *
 * Three hard rules (FEATURE_SCOPE 10.3 / 10.5 / 10.6):
 *  1. The only time axis is "measure.beat". Absolute timestamps are not written;
 *     mm:ss appears only at section boundaries and in the optional anchor table.
 *  2. Roman numerals are given once as a global lookup, never per line.
 *  3. Every template carries the same guardrail: melody, lyrics, timbre and
 *     drums must not be described.
 */

import {
  EMPTY_CELL,
  REST_CELL,
  formatMmSs,
  isSilenceCell,
  measureStartSeconds,
  type Timeline,
  type TimelineSection,
} from './analyze';
import type {
  PromptExportInput,
  PromptExportOptions,
  PromptExportResult,
  PromptTemplateId,
  PromptTimePrecision,
} from './types';

export const GUARDRAIL_SENTENCE =
  'You have not heard this audio and only have harmony data. Do not describe melody, lyrics, timbre, instrumentation, or drum patterns.';

const TEMPLATE_ROLE: Record<PromptTemplateId, string> = {
  harmony: 'You are a harmony analyst.',
  production: 'You are an arranger and producer.',
  data: '',
};

const TEMPLATE_TASK: Record<PromptTemplateId, string[]> = {
  harmony: [
    'Analyze the harmony data below and cover four things:',
    '1. Functional logic: explain the tonic / dominant / subdominant motion and the cadences.',
    '2. Progressions: name the recurring chord progressions (e.g. "I-V-vi-IV") and give their share.',
    '3. Borrowing and tonicization: point out chords outside the key and state where they come from.',
    '4. Section contrast: compare harmonic density, stability and tension between sections.',
    '',
    'Cite evidence by measure number ("measure N"). Do not restate the whole timeline.',
  ],
  production: [
    'Given the harmonic skeleton below, give 5 arranger suggestions that can be executed directly.',
    'Each suggestion must state: where it applies (measure N / a section), what changes (arrangement, groove, or reharmonization), and why.',
    '',
    'Avoid vague advice such as "add more atmosphere". Do not assume any specific timbre or playing technique.',
  ],
  data: ['The harmony data for this track follows. Use it according to my next instruction.'],
};

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Token estimate: ~3.6 chars/token for ASCII, ~1.3 chars/token otherwise. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.round(ascii / 3.6 + nonAscii / 1.3);
}

function formatConfidence(confidence: number | null | undefined): string | null {
  const value = Number(confidence);
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${Math.round(value * 100)}%`;
}

/** Degrees used in a section, de-duplicated in order, for the section skeleton. */
function sectionRomanPool(section: TimelineSection, timeline: Timeline): string[] {
  const pool: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < timeline.romanLegend.length; index += 1) {
    const entry = timeline.romanLegend[index];
    if (!section.chords.includes(entry.chord)) continue;
    if (seen.has(entry.roman)) continue;
    seen.add(entry.roman);
    pool.push(entry.roman);
  }
  return pool;
}

/** Basename only: an absolute path must never reach the exported text (10.1). */
function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function renderMetaLines(input: PromptExportInput, options: PromptExportOptions): string[] {
  const rawName = (input.trackName ?? '').trim();
  const trackName =
    options.includeTrackName && rawName ? basename(rawName) : 'Untitled track';
  const lines = [`- Track: ${trackName}`];

  const duration = Number(input.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) {
    lines.push(`- Duration: ${formatMmSs(duration)}`);
  }

  const bpm = Number(input.bpm);
  if (Number.isFinite(bpm) && bpm > 0) {
    lines.push(`- Tempo: ${Math.round(bpm)} BPM`);
  }

  const key = (input.keySignature ?? '').trim();
  const confidence = formatConfidence(input.keyConfidence);
  if (key) {
    lines.push(`- Key: ${key}${confidence ? ` (confidence ${confidence})` : ''}`);
  } else {
    lines.push('- Key: not detected');
  }

  lines.push(`- Time signature: ${input.timeSignature ?? 4}/4`);

  const models = [input.chordModel, input.beatModel].filter(Boolean);
  if (models.length) {
    lines.push(`- Models: ${models.join(' / ')}`);
  }
  if (input.engine) {
    lines.push(`- Harmony engine: ${input.engine}`);
  }

  return lines;
}

function renderSections(timeline: Timeline, precision: PromptTimePrecision): string[] {
  if (!timeline.sections.length) return [];
  const lines = [
    `Section boundaries (key-based segmentation, rule-based clustering, not a model segmenter; ${timeline.sections.length} ${timeline.sections.length === 1 ? 'section' : 'sections'}):`,
  ];

  timeline.sections.forEach((section, index) => {
    const startSeconds = measureStartSeconds(section.startMeasure, {
      timeSignature: timeline.timeSignature,
      beats: timeline.alignedBeats,
      bpm: timeline.bpm,
    });
    const span = section.endMeasure - section.startMeasure + 1;
    const maxChords = 24;
    const chordPool = section.chords.slice(0, maxChords).join(' ') +
      (section.chords.length > maxChords ? ` ...(+${section.chords.length - maxChords})` : '');
    const romanPool = precision === 'section' ? sectionRomanPool(section, timeline).join(' ') : '';
    const parts = [
      `${pad(index + 1, 2)}. ${formatMmSs(startSeconds)}`,
      `measures ${section.startMeasure}-${section.endMeasure} (${span} measures)`,
      section.key || 'key unknown',
      chordPool ? `chords: ${chordPool}` : '',
      romanPool ? `degrees: ${romanPool}` : '',
    ].filter(Boolean);
    lines.push(`  ${parts.join(' | ')}`);
  });

  return lines;
}

/** Chord changes within a measure, de-duplicated, without beat positions. */
function measureChangeList(cells: string[]): string {
  const changes: string[] = [];
  let last: string | null = null;
  for (const cell of cells) {
    if (isSilenceCell(cell)) continue;
    if (cell !== last) changes.push(cell);
    last = cell;
  }
  return changes.length ? changes.join(' ') : REST_CELL;
}

/** Run-length form within a measure: `Amx2 Fx2` (beat-level default). */
function measureRunLength(cells: string[]): string {
  const runs: Array<{ cell: string; count: number }> = [];
  for (const cell of cells) {
    const last = runs[runs.length - 1];
    if (last && last.cell === cell) {
      last.count += 1;
      continue;
    }
    runs.push({ cell, count: 1 });
  }
  return runs
    .map((run) => (run.count > 1 ? `${run.cell}x${run.count}` : run.cell))
    .join(' ');
}

/** Expanded fallback: `Am Am F F`, convertible back to the run-length form. */
export function expandRunLength(line: string): string {
  return line
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => {
      const match = /^(.+?)x(\d+)$/.exec(token);
      if (!match) return [token];
      const count = Number(match[2]);
      return Array.from({ length: Number.isFinite(count) && count > 0 ? count : 1 }, () => match[1]);
    })
    .join(' ');
}

function renderTimelineLines(timeline: Timeline, precision: PromptTimePrecision): string[] {
  const lines: string[] = [];
  const sectionByMeasure = new Map<number, number>();
  timeline.sections.forEach((section, index) => {
    for (let measure = section.startMeasure; measure <= section.endMeasure; measure += 1) {
      if (!sectionByMeasure.has(measure)) sectionByMeasure.set(measure, index);
    }
  });

  let currentSection = -1;
  const width = String(timeline.measures).length;

  for (let measure = 1; measure <= timeline.measures; measure += 1) {
    const sectionIndex = sectionByMeasure.get(measure);
    if (typeof sectionIndex === 'number' && sectionIndex !== currentSection) {
      currentSection = sectionIndex;
      const section = timeline.sections[sectionIndex];
      lines.push('');
      lines.push(`[Section ${pad(sectionIndex + 1, 2)} | ${section.key || 'key unknown'}]`);
    }

    const cells = timeline.measureCells[measure - 1] ?? [];
    const body =
      precision === 'measure' ? measureChangeList(cells) : measureRunLength(cells);
    lines.push(`${pad(measure, width)} | ${body}`);
  }

  return lines;
}

function renderAnchors(timeline: Timeline): string[] {
  const anchors: string[] = [];
  for (let measure = 1; measure <= timeline.measures; measure += 8) {
    const seconds = measureStartSeconds(measure, {
      timeSignature: timeline.timeSignature,
      beats: timeline.alignedBeats,
      bpm: timeline.bpm,
    });
    anchors.push(`${measure}->${formatMmSs(seconds)}`);
  }
  if (anchors.length < 2) return [];
  return [`Time anchors (every 8 measures, only for converting to human-readable time): ${anchors.join(' | ')}`];
}

function renderRomanLegend(timeline: Timeline): string[] {
  if (!timeline.romanLegend.length) return [];
  const table = timeline.romanLegend
    .map((entry) => `${entry.chord}=${entry.roman}`)
    .join(' | ');
  return [`Roman numerals (given once for the whole track, not repeated in the timeline): ${table}`];
}

interface Statistics {
  chordRuns: number;
  uniqueChords: number;
  changeRate: number;
  histogram: Array<{ chord: string; count: number; share: number }>;
  progressions: Array<{ progression: string; count: number; share: number }>;
}

function computeStatistics(timeline: Timeline): Statistics {
  // Count chord CHANGES, not beats, otherwise one long chord dominates the
  // histogram (measured: "Bb 11x 15%" is the change-count basis).
  const runs: string[] = [];
  for (let measure = 0; measure < timeline.measures; measure += 1) {
    for (const cell of timeline.measureCells[measure] ?? []) {
      if (isSilenceCell(cell)) continue;
      if (runs[runs.length - 1] !== cell) runs.push(cell);
    }
  }

  const counts = new Map<string, number>();
  for (const chord of runs) {
    counts.set(chord, (counts.get(chord) ?? 0) + 1);
  }

  const total = runs.length || 1;
  const histogram = [...counts.entries()]
    .map(([chord, count]) => ({ chord, count, share: count / total }))
    .sort((a, b) => b.count - a.count || a.chord.localeCompare(b.chord));

  const bigrams = new Map<string, number>();
  for (let index = 1; index < runs.length; index += 1) {
    const key = `${runs[index - 1]}->${runs[index]}`;
    bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
  }
  const progressions = [...bigrams.entries()]
    .filter(([, count]) => count >= 2)
    .map(([progression, count]) => ({ progression, count, share: count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    chordRuns: runs.length,
    uniqueChords: counts.size,
    changeRate: timeline.measures > 0 ? runs.length / timeline.measures : 0,
    histogram: histogram.slice(0, 10),
    progressions,
  };
}

function renderStatistics(stats: Statistics, timeline: Timeline): string[] {
  const lines: string[] = [];
  const top = stats.histogram
    .map((entry) => `${entry.chord} ${entry.count}x ${Math.round(entry.share * 100)}%`)
    .join(' | ');
  if (top) lines.push(`Chord histogram (by change count, ${stats.chordRuns} changes): ${top}`);

  if (stats.progressions.length) {
    const progressions = stats.progressions
      .map((entry) => `${entry.progression} (${entry.count}x)`)
      .join(' | ');
    lines.push(`Most frequent adjacent moves: ${progressions}`);
  }

  lines.push(
    `Chord change rate: ${stats.changeRate.toFixed(2)} per measure (${stats.chordRuns} changes / ${timeline.measures} measures)`
  );

  if (timeline.modulations.length) {
    const modulations = timeline.modulations
      .map((modulation) => `measure ${modulation.atMeasure} ${modulation.fromKey} -> ${modulation.toKey}`)
      .join(' | ');
    lines.push(`Modulations: ${modulations}`);
  } else {
    lines.push('Modulations: none (single key throughout)');
  }

  return lines;
}

export function buildPromptExport(
  input: PromptExportInput,
  timeline: Timeline,
  options: PromptExportOptions = {}
): PromptExportResult {
  const precision: PromptTimePrecision = options.precision ?? 'beat';
  const template: PromptTemplateId = options.template ?? 'harmony';
  const sections: string[] = [];

  const role = TEMPLATE_ROLE[template];
  if (role) {
    sections.push(`[ROLE] ${role}`);
    sections.push('');
  }

  sections.push('[TASK]', ...TEMPLATE_TASK[template], '');

  sections.push(
    '[CONSTRAINTS]',
    `- ${GUARDRAIL_SENTENCE}`,
    '- The only time axis is "measure.beat": the leading number is the measure, and position N inside the line is beat N.',
    '- Time signature ' + `${timeline.timeSignature}/4` + ` means ${timeline.timeSignature} columns per line; "${EMPTY_CELL}" is a grid placeholder (no usable beat information there) and "${REST_CELL}" is a rest.`,
    '- The data comes from a local rule-based engine and chord recognition is imperfect; ground conclusions in the timeline.',
    ''
  );

  sections.push('[METADATA]', ...renderMetaLines(input, options), '');

  const sectionLines = renderSections(timeline, precision);
  if (sectionLines.length) {
    sections.push(...sectionLines, '');
  }

  const precisionNote =
    precision === 'section'
      ? '[SECTION SKELETON] Section-level chord sets only; no per-measure or per-beat timeline.'
      : precision === 'measure'
        ? '[TIMELINE | measure level] One measure per line, listing the chord changes in that measure (no beat positions).'
        : '[TIMELINE | beat level] One measure per line, chords in beat order; `xN` means the chord lasts N beats (e.g. `Amx2 Fx2` = beats 1-2 Am, beats 3-4 F).';

  if (precision !== 'section') {
    sections.push(precisionNote, '');
    sections.push(...renderTimelineLines(timeline, precision), '');
  } else {
    sections.push(precisionNote, '');
  }

  const anchors = options.includeAnchors ? renderAnchors(timeline) : [];
  if (anchors.length) {
    sections.push(...anchors, '');
  }

  const legend = renderRomanLegend(timeline);
  if (legend.length) {
    sections.push(...legend, '');
  }

  const statistics = computeStatistics(timeline);
  sections.push('[STATISTICS]', ...renderStatistics(statistics, timeline), '');

  sections.push(
    '[SCOPE]',
    '- No audio, no absolute paths, no usernames.',
    '- No melody, lyrics, timbre, drums or playing technique: this analysis did not produce them.',
    '- Section boundaries come from key/harmony clustering and do not correspond to verse or chorus.'
  );

  const text = sections.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  return {
    text,
    charCount: text.length,
    approxTokens: estimateTokens(text),
    precision,
    template,
    stats: {
      measures: timeline.measures,
      beats: timeline.beats,
      chordRuns: statistics.chordRuns,
      sections: timeline.sections.length,
      modulations: timeline.modulations.length,
      uniqueChords: statistics.uniqueChords,
    },
    warnings: timeline.warnings,
  };
}
