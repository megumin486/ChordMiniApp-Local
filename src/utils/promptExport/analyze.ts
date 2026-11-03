/**
 * Folds the on-screen chord grid plus Roman numerals into a structured
 * timeline addressed by "measure.beat".
 *
 * Key constraint (lesson from Phase 3.5 v4.2): the beat -> Roman-numeral index
 * mapping MUST reuse `buildBeatToChordSequenceMap` from
 * `utils/chordFormatting/sequenceMap.ts`, which is the same mapping ChordGrid
 * uses when rendering. Writing a second comparison here would reintroduce the
 * "Roman numerals shifted by one" bug that took a full round to fix.
 */

import { createShiftedChords } from '@/utils/chordProcessing';
import { buildBeatToChordSequenceMap } from '@/utils/chordFormatting/sequenceMap';
import { prettyChordLabel } from './format';
import type {
  PromptExportInput,
  PromptModulation,
  PromptRomanNumerals,
} from './types';

/** Every no-chord spelling (matches gridConfig.silentChordValues). */
const NO_CHORD_FORMS = new Set(['N', 'N/C', 'N.C.', 'NC', 'NO CHORD', 'N.C']);

/**
 * Empty grid cell (padding/shift placeholder). Carries no chord information,
 * as opposed to REST_CELL which is a chord the model explicitly called silence.
 */
export const EMPTY_CELL = '·';

/** A rest the chord model actually detected. */
export const REST_CELL = 'N.C.';

export function normalizeCell(chord: string | null | undefined): string {
  const trimmed = (chord ?? '').trim();
  if (!trimmed) return EMPTY_CELL;
  if (NO_CHORD_FORMS.has(trimmed.toUpperCase())) return REST_CELL;
  // Fold Harte notation into the labels the grid shows (`Eb:maj` -> `Eb`)
  return prettyChordLabel(trimmed);
}

export function isSilenceCell(cell: string): boolean {
  return cell === EMPTY_CELL || cell === REST_CELL;
}

export interface TimelineSection {
  /** 1-based, inclusive measure range of the section. */
  startMeasure: number;
  endMeasure: number;
  key: string;
  /** Chords seen in this section, de-duplicated in order of first appearance. */
  chords: string[];
}

export interface Timeline {
  timeSignature: number;
  measures: number;
  beats: number;
  /** Beat times aligned with the shifted beat axis (seconds). */
  alignedBeats: Array<number | null>;
  bpm: number | null;
  /** Beat cells per measure; each row is exactly timeSignature long. */
  measureCells: string[][];
  /** Indexed like the beat axis: the Roman numeral for that beat, or null. */
  romanByBeat: Array<string | null>;
  /** Global chord -> Roman numeral lookup, in order of first appearance. */
  romanLegend: Array<{ chord: string; roman: string }>;
  sections: TimelineSection[];
  modulations: Array<PromptModulation & { atMeasure: number }>;
  warnings: string[];
}

export function clampTimeSignature(value: number | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 4;
  return Math.min(12, Math.round(parsed));
}

function buildSequenceToBeatIndex(
  shiftedChords: string[],
  romanNumerals: PromptRomanNumerals | null,
  paddingCount: number,
  shiftCount: number
): { seqToBeat: number[]; romanByBeat: Array<string | null> } {
  const analysis = romanNumerals?.analysis ?? [];
  const romanByBeat: Array<string | null> = shiftedChords.map(() => null);
  const seqToBeat: number[] = [];

  if (!analysis.length) {
    return { seqToBeat, romanByBeat };
  }

  // Called exactly like ChordGrid does (including the paddingCount diagnostic)
  // so the resulting mapping is identical to what the user sees.
  const beatToSequence = buildBeatToChordSequenceMap(
    shiftedChords.length,
    shiftedChords,
    { analysis },
    null,
    {
      source: 'promptExport',
      paddingCount,
      shiftCount,
      gridBeats: shiftedChords.length,
      mappingBeats: shiftedChords.length,
    }
  );

  for (const [beatIndexRaw, seqIndex] of Object.entries(beatToSequence)) {
    const beatIndex = Number(beatIndexRaw);
    if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex >= shiftedChords.length) {
      continue;
    }
    const roman = analysis[seqIndex];
    if (typeof roman === 'string' && roman.trim()) {
      romanByBeat[beatIndex] = roman.trim();
    }
    if (seqToBeat[seqIndex] === undefined) {
      seqToBeat[seqIndex] = beatIndex;
    }
  }

  return { seqToBeat, romanByBeat };
}

/** Converts a chord index to a 1-based measure number, clamped to range. */
function sequenceIndexToMeasure(
  seqIndex: number,
  seqToBeat: number[],
  timeSignature: number,
  measures: number
): number {
  const beatIndex = seqToBeat[Math.max(0, Math.round(seqIndex))];
  if (beatIndex === undefined) return measures;
  return Math.min(measures, Math.floor(beatIndex / timeSignature) + 1);
}

/**
 * End measure of a section.
 *
 * Using `endIndex` directly yields the beat where the LAST chord of the
 * section starts, which silently drops trailing rests (measured on test.mp3:
 * 76 measures were reported as 1-74). The correct value is the start of the
 * next section minus one, or the end of the track when there is no next one.
 */
function sequenceIndexToEndMeasure(
  seqIndex: number,
  seqToBeat: number[],
  timeSignature: number,
  measures: number
): number {
  const nextBeat = seqToBeat[Math.round(seqIndex) + 1];
  if (typeof nextBeat === 'number') {
    return Math.max(1, Math.min(measures, Math.ceil(nextBeat / timeSignature)));
  }
  return measures;
}

function buildSections(params: {
  romanNumerals: PromptRomanNumerals | null;
  modulations: PromptModulation[];
  seqToBeat: number[];
  timeSignature: number;
  measures: number;
  measureCells: string[][];
}): TimelineSection[] {
  const { romanNumerals, modulations, seqToBeat, timeSignature, measures, measureCells } = params;

  const romanSections = romanNumerals?.sections ?? [];
  const raw: Array<{ startMeasure: number; endMeasure: number; key: string }> = [];

  if (romanSections.length > 0) {
    for (const section of romanSections) {
      raw.push({
        startMeasure: sequenceIndexToMeasure(section.startIndex, seqToBeat, timeSignature, measures),
        // Using endIndex here would drop the trailing rest (76 -> 1-74)
        endMeasure: sequenceIndexToEndMeasure(section.endIndex, seqToBeat, timeSignature, measures),
        key: section.key,
      });
    }
  } else if (modulations.length > 0) {
    // No section data: split at the modulation points instead.
    const boundaries = [...modulations]
      .sort((a, b) => a.atIndex - b.atIndex)
      .map((modulation) => ({
        atMeasure: sequenceIndexToMeasure(modulation.atIndex, seqToBeat, timeSignature, measures),
        fromKey: modulation.fromKey,
        toKey: modulation.toKey,
      }));
    let cursor = 1;
    let currentKey = boundaries[0]?.fromKey ?? romanNumerals?.keyContext ?? '';
    for (const boundary of boundaries) {
      const end = Math.max(cursor, boundary.atMeasure - 1);
      raw.push({ startMeasure: cursor, endMeasure: Math.min(measures, end), key: currentKey });
      cursor = Math.max(cursor, boundary.atMeasure);
      currentKey = boundary.toKey;
    }
    raw.push({ startMeasure: cursor, endMeasure: measures, key: currentKey });
  } else {
    raw.push({ startMeasure: 1, endMeasure: measures, key: romanNumerals?.keyContext ?? '' });
  }

  return raw
    .filter((section) => section.endMeasure >= section.startMeasure)
    .map((section) => {
      const chords: string[] = [];
      const seen = new Set<string>();
      for (let measure = section.startMeasure; measure <= section.endMeasure; measure += 1) {
        for (const cell of measureCells[measure - 1] ?? []) {
          if (isSilenceCell(cell) || seen.has(cell)) continue;
          seen.add(cell);
          chords.push(cell);
        }
      }
      return { ...section, chords };
    });
}

function buildAlignedBeats(params: {
  shiftedLength: number;
  sourceBeats: Array<number | null>;
  bpm?: number | null;
}): Array<number | null> {
  const { shiftedLength, sourceBeats, bpm } = params;
  const result: Array<number | null> = new Array(shiftedLength).fill(null);

  const tempo = Number(bpm);
  const beatDuration = Number.isFinite(tempo) && tempo > 0 ? 60 / tempo : 0.5;

  // Source beats are indexed like the un-shifted chords; leading shift cells
  // have no real beat time of their own.
  const offset = Math.max(0, shiftedLength - sourceBeats.length);
  const firstSourceTime = sourceBeats.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );

  for (let index = 0; index < shiftedLength; index += 1) {
    const sourceIndex = index - offset;
    const value = sourceIndex >= 0 ? sourceBeats[sourceIndex] : null;

    if (typeof value === 'number' && Number.isFinite(value)) {
      result[index] = value;
      continue;
    }

    if (sourceIndex < 0) {
      // Leading padding/shift cells: extrapolate backwards from the first beat
      result[index] =
        typeof firstSourceTime === 'number'
          ? Math.max(0, firstSourceTime - (offset - index) * beatDuration)
          : null;
      continue;
    }

    const previous = result[index - 1];
    result[index] = typeof previous === 'number' ? previous + beatDuration : null;
  }

  return result;
}

export function buildTimeline(input: PromptExportInput): Timeline {
  const warnings: string[] = [];
  const timeSignature = clampTimeSignature(input.timeSignature);
  const rawChords = input.chords ?? [];
  // Same rule as ChordGrid / useChordDataProcessing: hasPadding means the
  // backend already encoded padding and shift into `chords`, so no extra
  // leading empty cells may be prepended.
  const hasPadding = Boolean(input.hasPadding);
  const shiftCount = Math.max(0, Math.round(Number(input.shiftCount) || 0));
  const paddingCount = Math.max(0, Math.round(Number(input.paddingCount) || 0));

  // Identical shifting rules to ChordGrid / useChordDataProcessing.
  const shiftedChords = rawChords.length
    ? createShiftedChords(rawChords, hasPadding, timeSignature, shiftCount)
    : [];

  const beatCount = shiftedChords.length;
  const measures = Math.max(0, Math.ceil(beatCount / timeSignature));

  // Beat times must align with the shifted cells: padding cells have no real
  // beat time, so they are extrapolated from the first detected beat (same
  // idea as gridAssembly's padding timestamp distribution).
  const alignedBeats = buildAlignedBeats({
    shiftedLength: beatCount,
    sourceBeats: input.beats ?? [],
    bpm: input.bpm,
  });

  const measureCells: string[][] = [];
  for (let measure = 0; measure < measures; measure += 1) {
    const row: string[] = [];
    for (let beat = 0; beat < timeSignature; beat += 1) {
      const index = measure * timeSignature + beat;
      row.push(index < beatCount ? normalizeCell(shiftedChords[index]) : EMPTY_CELL);
    }
    measureCells.push(row);
  }

  const romanNumerals = input.romanNumerals ?? null;
  if (!romanNumerals?.analysis?.length) {
    warnings.push(
      'Roman numerals unavailable (key detection returned no romanNumerals.analysis); this export has no degree lookup'
    );
  }

  const { seqToBeat, romanByBeat } = buildSequenceToBeatIndex(
    shiftedChords,
    romanNumerals,
    paddingCount,
    shiftCount
  );

  // Global lookup, de-duplicated by (chord, degree) because the same chord can
  // map to different degrees after a modulation.
  const romanLegend: Array<{ chord: string; roman: string }> = [];
  const legendSeen = new Set<string>();
  for (let index = 0; index < shiftedChords.length; index += 1) {
    const cell = normalizeCell(shiftedChords[index]);
    const roman = romanByBeat[index];
    if (!roman || isSilenceCell(cell)) continue;
    const dedupeKey = `${cell}\u0000${roman}`;
    if (legendSeen.has(dedupeKey)) continue;
    legendSeen.add(dedupeKey);
    romanLegend.push({ chord: cell, roman });
  }

  const modulations = (input.modulations ?? []).map((modulation) => ({
    ...modulation,
    atMeasure: sequenceIndexToMeasure(modulation.atIndex, seqToBeat, timeSignature, measures),
  }));

  const sections = buildSections({
    romanNumerals,
    modulations: input.modulations ?? [],
    seqToBeat,
    timeSignature,
    measures,
    measureCells,
  });

  if (sections.length <= 1) {
    warnings.push(
      'Section skeleton: no modulation detected, the whole track is reported as a single section (key-based segmentation, not verse/chorus)'
    );
  }

  return {
    timeSignature,
    measures,
    beats: beatCount,
    alignedBeats,
    bpm: Number.isFinite(Number(input.bpm)) && Number(input.bpm) > 0 ? Number(input.bpm) : null,
    measureCells,
    romanByBeat,
    romanLegend,
    sections,
    modulations,
    warnings,
  };
}

/** Measure number -> seconds. Uses real beat times, falling back to BPM. */
export function measureStartSeconds(
  measure: number,
  params: { timeSignature: number; beats?: Array<number | null>; bpm?: number | null }
): number | null {
  const { timeSignature, beats, bpm } = params;
  const beatIndex = (measure - 1) * timeSignature;
  const beatTime = beats?.[beatIndex];
  if (typeof beatTime === 'number' && Number.isFinite(beatTime)) return beatTime;
  const tempo = Number(bpm);
  if (Number.isFinite(tempo) && tempo > 0) {
    return (beatIndex * 60) / tempo;
  }
  return null;
}

export function formatMmSs(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
