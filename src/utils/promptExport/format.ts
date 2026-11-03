/**
 * Folds backend Harte notation (`Eb:maj`, `Bb:maj/3`, `C:min7`) into the same
 * readable labels the grid shows.
 *
 * Why not keep Harte verbatim: the prompt is read by a human and pasted into an
 * external AI, where `Bb:maj/3` is both longer and needs explaining, while the
 * UI already performs this conversion. The output deliberately uses ASCII
 * accidentals (`Eb`, not `E♭`) to match `keySignature` (stored as `Eb major`)
 * and avoid encoding mismatches when pasting.
 */

import { getBassNoteFromInversion } from '@/utils/chordFormatting/inversions';

const QUALITY_MAP: Record<string, string> = {
  maj: '',
  major: '',
  min: 'm',
  minor: 'm',
  dim: 'dim',
  hdim: 'm7b5',
  aug: 'aug',
  sus: 'sus',
  sus2: 'sus2',
  sus4: 'sus4',
};

function mapQuality(quality: string): string {
  const lower = quality.toLowerCase();
  const direct = QUALITY_MAP[lower];
  if (direct !== undefined) return direct;

  // min7 / maj7 / dim7 / aug7 ...: map the prefix, keep the numeric suffix
  const match = /^(maj|min|major|minor|dim|hdim|aug|sus[24]?)(.*)$/.exec(lower);
  if (match) {
    const [, head, tail] = match;
    const mapped = QUALITY_MAP[head] ?? head;
    return `${mapped}${tail}`;
  }

  return quality;
}

/** `Eb:maj` -> `Eb`; `Bb:maj/3` -> `Bb/D`; non-Harte input passes through. */
export function prettyChordLabel(chord: string): string {
  const trimmed = (chord ?? '').trim();
  if (!trimmed) return '';
  if (!trimmed.includes(':')) return trimmed;

  const [chordPart, inversion] = trimmed.split('/');
  const [root, rawQuality = ''] = chordPart.split(':');
  if (!root) return trimmed;

  const quality = mapQuality(rawQuality);
  if (!inversion) return `${root}${quality}`;

  const bass = /^[A-G](#|b)?$/.test(inversion)
    ? inversion
    : getBassNoteFromInversion(root, rawQuality || 'maj', inversion) || inversion;

  return `${root}${quality}/${bass}`;
}
