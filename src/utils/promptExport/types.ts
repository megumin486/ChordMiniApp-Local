/**
 * Types for the AI prompt export (FEATURE_SCOPE section 10 / item 27).
 *
 * Design rules (see FEATURE_SCOPE 10.2-10.6):
 *  - The only time axis is "measure.beat". Absolute timestamps are not emitted
 *    (mm:ss appears only at section boundaries).
 *  - The three precision levels are mutually exclusive: section / measure /
 *    beat. Exactly one timeline layer is rendered per export.
 *  - Roman numerals are given once as a global lookup, never repeated per line.
 *  - All three templates carry the same guardrail sentence (no melody, lyrics,
 *    timbre or drums may be described).
 */

/**
 * Timeline precision. Deliberately not called "detail level": the three
 * options are granularities of the same information, not a quality scale.
 */
export type PromptTimePrecision = 'section' | 'measure' | 'beat';

/** Template, distinguished by task rather than by writing style. */
export type PromptTemplateId = 'harmony' | 'production' | 'data';

export interface PromptRomanSection {
  startIndex: number;
  endIndex: number;
  key: string;
}

export interface PromptRomanNumerals {
  analysis: string[];
  keyContext?: string;
  sections?: PromptRomanSection[];
  temporalShifts?: Array<{
    chordIndex: number;
    targetKey: string;
    romanNumeral: string;
  }>;
}

export interface PromptModulation {
  fromKey: string;
  toKey: string;
  atIndex: number;
}

/**
 * Generator input.
 *
 * `chords` and `beats` must come from the same arrays ChordGrid renders (i.e.
 * already including padding/shift cells) so that the beat -> sequence mapping
 * in `buildBeatToChordSequenceMap` matches the Roman numerals shown on screen.
 * That mapping is exactly the alignment bug fixed in Phase 3.5 v4.2; do not
 * reimplement the comparison here.
 */
export interface PromptExportInput {
  /** Original file name (basename only). Redacted unless includeTrackName. */
  trackName?: string | null;
  durationSeconds?: number | null;
  bpm?: number | null;
  /** Time signature; 4 means 4/4. Determines how many columns each line has. */
  timeSignature?: number | null;
  /** Formatted like "Eb major" (ASCII accidentals, matching the cache). */
  keySignature?: string | null;
  /** Key confidence in 0..1. Backend `keyConfidence`, forwarded by detect-key. */
  keyConfidence?: number | null;
  /** Display chord array: `chordGridData.chords` after createShiftedChords. */
  chords: string[];
  /** Beat times in seconds, indexed like `chords`. Nulls are allowed. */
  beats?: Array<number | null>;
  /** Whether the backend already encoded padding into `chords`. */
  hasPadding?: boolean;
  paddingCount?: number;
  shiftCount?: number;
  romanNumerals?: PromptRomanNumerals | null;
  modulations?: PromptModulation[] | null;
  chordModel?: string | null;
  beatModel?: string | null;
  /** Harmony engine description, e.g. "music21 + harte-library + madmom-key-cnn". */
  engine?: string | null;
}

export interface PromptExportOptions {
  /** Defaults to 'beat' (see 10.2). */
  precision?: PromptTimePrecision;
  /** Defaults to 'harmony' (template A). */
  template?: PromptTemplateId;
  /** Sparse time anchors every 8 measures; only emitted when requested. */
  includeAnchors?: boolean;
  /** The track name is redacted to "Untitled track" by default. */
  includeTrackName?: boolean;
}

export interface PromptExportStats {
  measures: number;
  beats: number;
  chordRuns: number;
  sections: number;
  modulations: number;
  uniqueChords: number;
}

export interface PromptExportResult {
  text: string;
  charCount: number;
  /** Approximation, not a tokenizer result; see estimateTokens. */
  approxTokens: number;
  precision: PromptTimePrecision;
  template: PromptTemplateId;
  stats: PromptExportStats;
  /** Explicit notes about missing data sources; also written into the text. */
  warnings: string[];
}
