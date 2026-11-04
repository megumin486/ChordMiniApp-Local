import React from 'react';
import { render, screen } from '@testing-library/react';
import { LyricLine } from '@/components/lyrics/LyricLine';
import { getLyricTextColors } from '@/components/lyrics/lyricsTheme';

/**
 * A bilingual lyric line renders its second track underneath the sung text.
 */
describe('LyricLine (bilingual)', () => {
  const line = {
    startTime: 0,
    endTime: 4,
    text: 'konnichiwa',
    translation: 'translated line',
    translationLanguage: 'zh',
    chords: [{ time: 0, chord: 'C', position: 0 }],
  };

  const renderLine = (overrides: Record<string, unknown> = {}) => {
    const value = { ...line, ...overrides };
    return render(
      <LyricLine
        line={value}
        index={0}
        isActive={false}
        isPast={false}
        currentTime={0}
        fontSize={18}
        textColors={getLyricTextColors(false)}
        darkMode={false}
        selectedLanguages={[]}
        translatedLyrics={{}}
        processedLines={[value]}
      />,
    );
  };

  it('renders the translation under the sung line', () => {
    renderLine();
    expect(screen.getByText('translated line')).toBeTruthy();
  });

  it('renders nothing extra when the line has no translation', () => {
    renderLine({ translation: undefined });
    expect(screen.queryByText('translated line')).toBeNull();
  });
});