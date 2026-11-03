import { getChordComparisonKey } from '@/utils/chordProcessing';
import { dbg } from '@/utils/debugLog';

/**
 * Builds mapping from beat index to chord sequence index for Roman numerals.
 *
 * DESIGN NOTE (local-only build, 2026-10-31, revised):
 *
 * The analyse page sends a *de-duplicated* chord sequence to /api/detect-key:
 * `rawChordData.filter((chord, index) => index === 0 || chord.chord !== rawChordData[index - 1].chord)`
 * — i.e. consecutive entries are compared with **raw string equality**.
 * The backend returns `romanNumerals.analysis` and
 * `sequenceCorrections.correctedSequence` aligned 1:1 with that de-duplicated
 * sequence.
 *
 * Therefore the correct mapping is purely positional: walk the (shifted) chord
 * sequence, and every time the chord changes advance the sequence index by one.
 * The comparison used here MUST match the de-duplication exactly (raw string
 * equality) — an enharmonic-insensitive key merges adjacent segments that the
 * backend kept separate (e.g. "Eb" next to "D#") and shifts every later Roman
 * numeral by one, which shows up as spurious N.C. labels and misaligned
 * annotations.
 *
 * The previous implementation searched the reference sequence for a matching
 * chord name, which broke whenever a chord repeated (e.g. Eb:maj appearing many
 * times): it jumped to a distant match or fell back to "+1", producing
 * cumulative drift, spurious N.C. entries and wrong Roman numerals.
 */

/**
 * No-chord spellings that the grid and the model disagree on.
 *
 * The grid assembles its first cell(s) with the adapter's *padding* chord, which
 * is `"N.C."` (dotted), while the chord model emits `"N/C"` (slashed) for the
 * same silence. The backend normalizes both to `None` (see
 * `chord_normalizer.NO_CHORD_TOKENS`) so it treats them as ONE silent run, while
 * a strict raw-string walk over the grid array counts TWO — the padded cell and
 * the model's silence. That extra run shifted every Roman numeral one chord to
 * the right for songs whose first beat is padding while the model's opening
 * segment is a no-chord (observed on a.mp3: 102 grid runs vs 101 numerals).
 */
const NO_CHORD_FORMS = new Set(['N', 'N/C', 'N.C.', 'NC', 'NO CHORD']);

/**
 * Canonical form used for run detection. No-chord spellings collapse to one
 * value; every other chord is compared as the raw string, exactly like the
 * de-duplication that produced `analysis` (an enharmonic-insensitive comparison
 * would merge segments the backend kept apart and shift the numerals again).
 */
function canonicalRunChord(chord: string): string {
  const trimmed = chord.trim();
  if (!trimmed) return '';
  if (NO_CHORD_FORMS.has(trimmed.toUpperCase())) return 'N.C.';
  return chord;
}

type SequenceMapDiagnostics = {
  source?: string;
  hasPadding?: boolean;
  paddingCount?: number;
  shiftCount?: number;
  simplifyChords?: boolean;
  [key: string]: unknown;
};

let lastDiagnosticSignature: string | null = null;

function countRuns(chords: string[], mode: 'raw' | 'key'): { runs: number; changeAt: number[] } {
  const changeAt: number[] = [];
  let last: string | null = null;
  let seen = false;

  for (let index = 0; index < chords.length; index++) {
    const chord = chords[index];
    if (!chord) continue;
    const value =
      mode === 'raw' ? canonicalRunChord(chord) : getChordComparisonKey(chord);
    if (seen && value !== last) changeAt.push(index);
    last = value;
    seen = true;
  }

  return { runs: seen ? changeAt.length + 1 : 0, changeAt };
}

function logSequenceMapDiagnostic(
  shiftedChords: string[],
  analysis: string[],
  diagnostics?: SequenceMapDiagnostics
): void {
  const raw = countRuns(shiftedChords, 'raw');
  const key = countRuns(shiftedChords, 'key');

  const signature = [
    shiftedChords.length,
    analysis.length,
    raw.runs,
    key.runs,
    diagnostics?.source ?? '',
    diagnostics?.paddingCount ?? '',
    diagnostics?.shiftCount ?? '',
    shiftedChords.slice(0, 16).join(','),
  ].join('|');

  if (signature === lastDiagnosticSignature) return;
  lastDiagnosticSignature = signature;

  dbg('sequenceMap', {
    beats: shiftedChords.length,
    analysisLength: analysis.length,
    runsRaw: raw.runs,
    runsKey: key.runs,
    rawMismatch: raw.runs - analysis.length,
    keyMismatch: key.runs - analysis.length,
    beatsPreview: shiftedChords,
    analysisPreview: analysis,
    rawChangeAt: raw.changeAt,
    keyChangeAt: key.changeAt,
    context: diagnostics ?? null,
  });
}

export const buildBeatToChordSequenceMap = (
  chordsLength: number,
  shiftedChords: string[],
  romanNumeralData: { analysis: string[] } | null,
  _sequenceCorrections: { correctedSequence: string[] } | null,
  diagnostics?: SequenceMapDiagnostics
): Record<number, number> => {
  if (chordsLength === 0 || !romanNumeralData?.analysis) return {};

  const analysis = romanNumeralData.analysis;
  const map: Record<number, number> = {};

  // The grid prepends the adapter's padding chord for the beats that precede the
  // detected chord sequence. Those cells are a *display* artifact — the backend
  // never received them — so they must not claim a sequence slot, otherwise every
  // Roman numeral after them is shifted by one (observed on a.mp3: 102 grid runs
  // vs 101 numerals, first cell showing "I" instead of "N.C.").
  const leadingPaddingCount = Math.max(
    0,
    Math.floor(Number(diagnostics?.paddingCount ?? 0)) || 0
  );

  let sequenceIndex = 0;
  let lastChord: string | null = null;
  let paddingSkipped = 0;
  let sequenceStarted = false;

  for (let beatIndex = 0; beatIndex < shiftedChords.length; beatIndex++) {
    const currentChord = shiftedChords[beatIndex];

    // Skip empty slots (grid shift cells) without consuming a sequence entry.
    if (!currentChord || currentChord === '') {
      continue;
    }

    // Skip the leading padding cells as well (they render without a numeral).
    if (!sequenceStarted && paddingSkipped < leadingPaddingCount) {
      paddingSkipped += 1;
      continue;
    }
    sequenceStarted = true;

    // Advance one slot each time the chord changes. No-chord spellings are
    // collapsed first (grid padding "N.C." vs model "N/C" are the same silence
    // for the backend), every other chord is compared as the raw string — the
    // same basis as the de-duplication that produced `analysis`. The first
    // chord claims index 0 and is NOT counted as a change.
    const currentValue = canonicalRunChord(currentChord);
    if (lastChord !== null && currentValue !== lastChord) {
      sequenceIndex += 1;
    }
    lastChord = currentValue;

    if (sequenceIndex < analysis.length) {
      map[beatIndex] = sequenceIndex;
    }
  }

  logSequenceMapDiagnostic(shiftedChords, analysis, diagnostics);

  return map;
};
