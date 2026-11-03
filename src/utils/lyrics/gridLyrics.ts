import type { LyricsData } from '@/types/musicAiTypes';
import type { BeatGridTimedLyrics } from '@/components/chord-analysis/GridLyricsRow';

/**
 * Local-only fork: the chord grid used to receive its lyric rows from the
 * LRCLIB search dialog (removed in Phase 5). Whatever lyrics we now have
 * locally — a file the user picked or lyric tags embedded in the audio — are
 * laid into the grid automatically, so these two helpers convert the shared
 * `LyricsData` into the shapes `ChordGrid` / `GuitarChordsTab` /
 * `PianoVisualizerTab` already accept.
 */

const hasLines = (lyrics: LyricsData | null | undefined): lyrics is LyricsData =>
  Boolean(lyrics && Array.isArray(lyrics.lines) && lyrics.lines.length > 0);

/**
 * Word-level highlight only when at least one line actually carries word
 * timings (they can come from embedded synchronized tags). Everything else
 * falls back to the line-level mode the grid tints per line.
 */
export function toGridTimedLyrics(
  lyrics: LyricsData | null | undefined
): BeatGridTimedLyrics | null {
  if (!hasLines(lyrics)) return null;

  const hasWordTimings = lyrics.lines.some(
    (line) => Array.isArray(line.wordTimings) && line.wordTimings.length > 0
  );

  return {
    mode: hasWordTimings ? 'word' : 'line',
    lyrics,
  };
}

/** Plain one-line-per-row lyrics for the grid's plain lyric strip. */
export function toGridPlainLyrics(lyrics: LyricsData | null | undefined): string | null {
  if (!hasLines(lyrics)) return null;

  const text = lyrics.lines.map((line) => line.text).join('\n');
  return text.trim().length > 0 ? text : null;
}