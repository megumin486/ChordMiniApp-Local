import type { LyricsData } from '@/types/musicAiTypes';
import type { BeatGridTimedLyrics } from '@/components/chord-analysis/GridLyricsRow';

/**
 * Local-only fork: the chord grid used to receive its lyric rows from the
 * LRCLIB search dialog (removed in Phase 5). Whatever lyrics we now have
 * locally 鈥?a file the user picked or lyric tags embedded in the audio 鈥?are
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

