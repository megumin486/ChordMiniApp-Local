import { toGridTimedLyrics } from '@/utils/lyrics/gridLyrics';
import type { LyricsData, LyricWordTiming } from '@/types/musicAiTypes';

const line = (text: string, startTime: number, endTime: number, wordTimings?: LyricWordTiming[]) => ({
  text,
  startTime,
  endTime,
  ...(wordTimings ? { wordTimings } : {}),
});

const lyrics = (...lines: ReturnType<typeof line>[]): LyricsData => ({
  lines: lines as LyricsData['lines'],
});

describe('toGridTimedLyrics', () => {
  it('returns null for missing or empty lyrics', () => {
    expect(toGridTimedLyrics(null)).toBeNull();
    expect(toGridTimedLyrics(undefined)).toBeNull();
    expect(toGridTimedLyrics({ lines: [] })).toBeNull();
  });

  it('uses line mode when no line carries word timings', () => {
    const data = lyrics(line('hello', 0, 2), line('world', 2, 4));
    expect(toGridTimedLyrics(data)).toEqual({ mode: 'line', lyrics: data });
  });

  it('uses word mode when at least one line carries word timings', () => {
    const timing: LyricWordTiming = {
      text: 'hello',
      startTime: 0,
      endTime: 1,
      startChar: 0,
      endChar: 5,
    };
    const data = lyrics(line('hello', 0, 2, [timing]), line('world', 2, 4));
    expect(toGridTimedLyrics(data)).toEqual({ mode: 'word', lyrics: data });
  });

  it('ignores empty wordTimings arrays', () => {
    const data = lyrics(line('hello', 0, 2, []));
    expect(toGridTimedLyrics(data)?.mode).toBe('line');
  });

  it('passes the same object through instead of copying it', () => {
    const data = lyrics(line('hello', 0, 2));
    expect(toGridTimedLyrics(data)?.lyrics).toBe(data);
  });
});

