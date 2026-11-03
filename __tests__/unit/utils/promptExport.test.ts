import {
  GUARDRAIL_SENTENCE,
  buildTimeline,
  expandRunLength,
  generatePromptExport,
} from '@/utils/promptExport';
import { prettyChordLabel } from '@/utils/promptExport/format';
import type { PromptExportInput } from '@/utils/promptExport';

/**
 * Regression tests for item 27 (AI prompt export).
 *
 * They guard the FEATURE_SCOPE 10.8 acceptance criteria: the guardrail
 * sentence, measure.beat-only coordinates, Roman numerals given once as a
 * lookup, run-length and expanded forms being interconvertible, and no
 * absolute paths or usernames leaking into the output.
 */

// 4/4, two measures: measure 1 = Am Am F F, measure 2 = G G G G
const BASE_INPUT: PromptExportInput = {
  trackName: 'C:\\Users\\someone\\Desktop\\secret.mp3',
  durationSeconds: 12,
  bpm: 120,
  timeSignature: 4,
  keySignature: 'C major',
  keyConfidence: 0.87,
  chords: ['Am', 'Am', 'F', 'F', 'G', 'G', 'G', 'G'],
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  hasPadding: false,
  paddingCount: 0,
  shiftCount: 0,
  romanNumerals: {
    analysis: ['vi', 'IV', 'V'],
    keyContext: 'C major',
    sections: [{ startIndex: 0, endIndex: 2, key: 'C major' }],
  },
  modulations: [],
  chordModel: 'chord-cnn-lstm',
  beatModel: 'madmom',
  engine: 'music21 + harte-library + madmom-key-cnn',
};

describe('harte label formatting', () => {
  it('folds harte qualities into the labels the grid shows', () => {
    expect(prettyChordLabel('Eb:maj')).toBe('Eb');
    expect(prettyChordLabel('C:min7')).toBe('Cm7');
    expect(prettyChordLabel('G:7')).toBe('G7');
    expect(prettyChordLabel('Bb:maj/3')).toBe('Bb/D');
    expect(prettyChordLabel('Bb:maj/5')).toBe('Bb/F');
    expect(prettyChordLabel('Am')).toBe('Am');
    expect(prettyChordLabel('N.C.')).toBe('N.C.');
  });

  it('keeps the timeline in the same notation the user sees on the grid', () => {
    const timeline = buildTimeline({
      ...BASE_INPUT,
      chords: ['Eb:maj', 'Eb:maj', 'Bb:maj/3', 'Bb:maj/3'],
      romanNumerals: { analysis: ['I', 'V6'], keyContext: 'Eb major' },
    });
    expect(timeline.measureCells[0]).toEqual(['Eb', 'Eb', 'Bb/D', 'Bb/D']);
  });
});

describe('promptExport timeline', () => {
  it('groups beats into measures of the detected time signature', () => {
    const timeline = buildTimeline(BASE_INPUT);
    expect(timeline.timeSignature).toBe(4);
    expect(timeline.measures).toBe(2);
    expect(timeline.measureCells).toEqual([
      ['Am', 'Am', 'F', 'F'],
      ['G', 'G', 'G', 'G'],
    ]);
  });

  it('normalizes every no-chord spelling to one token', () => {
    const timeline = buildTimeline({
      ...BASE_INPUT,
      chords: ['N/C', 'N.C.', 'NC', ''],
    });
    expect(timeline.measureCells[0]).toEqual(['N.C.', 'N.C.', 'N.C.', '·']);
  });

  it('collapses roman numerals into a legend instead of per-line repeats', () => {
    const timeline = buildTimeline(BASE_INPUT);
    expect(timeline.romanLegend).toEqual([
      { chord: 'Am', roman: 'vi' },
      { chord: 'F', roman: 'IV' },
      { chord: 'G', roman: 'V' },
    ]);
  });

  it('warns instead of silently dropping missing data', () => {
    const timeline = buildTimeline({ ...BASE_INPUT, romanNumerals: null });
    expect(timeline.romanLegend).toHaveLength(0);
    expect(timeline.warnings.join()).toContain('Roman numerals unavailable');
    expect(timeline.warnings.join()).toContain('single section');
  });

  it('keeps the section tail instead of stopping at the last chord change', () => {
    // Regression: the last section used to convert endIndex directly, which
    // dropped the trailing rest (measured on test.mp3: 76 measures became 1-74)
    const timeline = buildTimeline(BASE_INPUT);
    expect(timeline.sections).toHaveLength(1);
    expect(timeline.sections[0].startMeasure).toBe(1);
    expect(timeline.sections[0].endMeasure).toBe(timeline.measures);
  });
});

describe('promptExport rendering', () => {
  it('always carries the guardrail sentence in every template', () => {
    for (const template of ['harmony', 'production', 'data'] as const) {
      const result = generatePromptExport(BASE_INPUT, { template });
      expect(result.text).toContain(GUARDRAIL_SENTENCE);
    }
  });

  it('uses measure.beat coordinates and never absolute timestamps in the timeline', () => {
    const result = generatePromptExport(BASE_INPUT, { precision: 'beat' });
    expect(result.text).toContain('1 | Amx2 Fx2');
    expect(result.text).toContain('2 | Gx4');
    // Timeline lines must not contain mm:ss
    const timelineLines = result.text
      .split('\n')
      .filter((line) => /^\s*\d+ \|/.test(line));
    expect(timelineLines.length).toBe(2);
    for (const line of timelineLines) {
      expect(line).not.toMatch(/\d+:\d{2}/);
    }
  });

  it('renders one single timeline layer per precision level', () => {
    const section = generatePromptExport(BASE_INPUT, { precision: 'section' });
    const measure = generatePromptExport(BASE_INPUT, { precision: 'measure' });
    const beat = generatePromptExport(BASE_INPUT, { precision: 'beat' });

    expect(section.text).not.toMatch(/^\s*\d+ \|/m);
    // Measure level: changes only, no beat positions
    expect(measure.text).toContain('1 | Am F');
    expect(measure.text).toContain('2 | G');
    expect(beat.text).toContain('Amx2');
    // Mutually exclusive: section level has no per-beat run length
    expect(section.text).not.toContain('x2');
    expect(beat.charCount).toBeGreaterThan(measure.charCount);
  });

  it('redacts the track name unless explicitly requested', () => {
    const redacted = generatePromptExport(BASE_INPUT, {});
    expect(redacted.text).toContain('Untitled track');
    expect(redacted.text).not.toContain('secret.mp3');

    const named = generatePromptExport(BASE_INPUT, { includeTrackName: true });
    expect(named.text).toContain('secret.mp3');
  });

  it('never leaks absolute paths or usernames', () => {
    const result = generatePromptExport(BASE_INPUT, { includeTrackName: true });
    expect(result.text).not.toMatch(/[A-Za-z]:\\\\/);
    expect(result.text).not.toContain('/Users/');
    expect(result.text).not.toContain('/home/');
  });

  it('reports key confidence and modulation facts', () => {
    const result = generatePromptExport(BASE_INPUT, {});
    expect(result.text).toContain('C major (confidence 87%)');
    expect(result.text).toContain('Modulations: none');
  });

  it('adds mm:ss anchors only when opted in', () => {
    const without = generatePromptExport(BASE_INPUT, {});
    expect(without.text).not.toContain('Time anchors');

    const longEnough = generatePromptExport(
      { ...BASE_INPUT, chords: Array.from({ length: 72 }, () => 'C'), beats: Array.from({ length: 72 }, (_, i) => i * 0.5) },
      { includeAnchors: true }
    );
    expect(longEnough.text).toContain('Time anchors');
  });

  it('is deterministic for the same input', () => {
    const first = generatePromptExport(BASE_INPUT, { precision: 'beat' });
    const second = generatePromptExport(BASE_INPUT, { precision: 'beat' });
    expect(second.text).toBe(first.text);
  });

  it('estimates tokens and counts characters', () => {
    const result = generatePromptExport(BASE_INPUT, {});
    expect(result.charCount).toBe(result.text.length);
    expect(result.approxTokens).toBeGreaterThan(0);
    expect(result.approxTokens).toBeLessThan(result.charCount);
  });
});

describe('run-length format', () => {
  it('expands back to the per-beat form', () => {
    expect(expandRunLength('Amx2 Fx2')).toBe('Am Am F F');
    expect(expandRunLength('Gx4')).toBe('G G G G');
    expect(expandRunLength('Am F')).toBe('Am F');
  });

  it('keeps the beat-level line losslessly convertible', () => {
    const timeline = buildTimeline(BASE_INPUT);
    const result = generatePromptExport(BASE_INPUT, { precision: 'beat' });
    const line = result.text.split('\n').find((item) => /^\s*1 \|/.test(item)) ?? '';
    const body = line.replace(/^\s*\d+ \| /, '');
    expect(expandRunLength(body).split(' ')).toEqual(timeline.measureCells[0]);
  });
});

describe('promptExport statistics', () => {
  it('counts chord changes by run, not by beat', () => {
    const result = generatePromptExport(BASE_INPUT, {});
    expect(result.stats.measures).toBe(2);
    expect(result.stats.beats).toBe(8);
    expect(result.stats.chordRuns).toBe(3);
    expect(result.stats.uniqueChords).toBe(3);
    expect(result.text).toContain('Chord change rate: 1.50 per measure');
  });

  it('names the most frequent adjacent progressions', () => {
    // A bigram needs at least two occurrences to be listed
    const result = generatePromptExport(
      {
        ...BASE_INPUT,
        chords: ['Am', 'Am', 'F', 'F', 'Am', 'Am', 'F', 'F', 'G', 'G', 'G', 'G'],
        beats: Array.from({ length: 12 }, (_, index) => index * 0.5),
        romanNumerals: { analysis: ['vi', 'IV', 'vi', 'IV', 'V'], keyContext: 'C major' },
      },
      {}
    );
    expect(result.text).toContain('Most frequent adjacent moves');
    // Am F Am F G -> Am->F twice, the others only once (below the threshold)
    expect(result.text).toContain('Am->F (2x)');
  });
});
