import { renderHook } from '@testing-library/react';
import { useProcessedLyrics } from '@/hooks/lyrics/useProcessedLyrics';

/**
 * The panel pipeline rebuilds lines several times (section -> chords ->
 * character timing), and every rebuild used to drop `translation`. This test
 * pins the field so a bilingual line keeps both tracks through the whole path.
 */
describe('useProcessedLyrics (bilingual)', () => {
  it('keeps the translation of a bilingual line through the pipeline', () => {
    const lyrics = {
      lines: [
        {
          startTime: 0.31,
          endTime: 1.16,
          text: 'original line',
          translation: 'translated line',
          translationLanguage: 'zh',
          chords: [],
        },
      ],
    };

    const { result } = renderHook(() => useProcessedLyrics({
      lyrics,
      beatAlignedChords: [{ time: 0.5, chord: 'C' }],
      segmentationData: null,
    }));

    const line = result.current.find((item) => item.text === 'original line');
    expect(line).toBeTruthy();
    expect(line?.translation).toBe('translated line');
    expect(line?.translationLanguage).toBe('zh');
  });

  it('keeps the translation when the line is also a display line after chord mapping', () => {
    const lyrics = {
      lines: [
        { startTime: 1, endTime: 2, text: 'x', chords: [] },
        {
          startTime: 2,
          endTime: 3,
          text: 'sung',
          translation: 'translated',
          chords: [],
        },
      ],
    };

    const { result } = renderHook(() => useProcessedLyrics({
      lyrics,
      beatAlignedChords: [
        { time: 1.2, chord: 'Am' },
        { time: 2.2, chord: 'F' },
      ],
      segmentationData: null,
    }));

    const line = result.current.find((item) => item.text === 'sung');
    expect(line?.translation).toBe('translated');
  });
});