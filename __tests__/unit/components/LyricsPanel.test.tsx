import React from 'react';
import { render, screen } from '@testing-library/react';
import LyricsPanel from '@/components/lyrics/LyricsPanel';

/**
 * The restored floating lyrics panel renders local lyrics only: it lists the
 * loaded lines with their timestamps, highlights the line under the playhead,
 * and shows an empty state that points at the local lyric sources.
 */
describe('LyricsPanel', () => {
  const lyrics = {
    lines: [
      { startTime: 1, endTime: 3, text: 'first line' },
      { startTime: 3, endTime: 5, text: 'second line' },
    ],
  };

  const renderPanel = (overrides: Record<string, unknown> = {}) => {
    const props = {
      isOpen: true,
      onClose: () => {},
      videoTitle: 'test.mp3',
      currentTime: 3.5,
      lyrics,
      ...overrides,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return render(<LyricsPanel {...(props as any)} />);
  };

  it('renders the loaded lines with their timestamps', () => {
    renderPanel();
    expect(screen.getByText('Song Lyrics')).toBeTruthy();
    expect(screen.getByText('first line')).toBeTruthy();
    expect(screen.getByText('second line')).toBeTruthy();
    expect(screen.getByText('0:01.0')).toBeTruthy();
    expect(screen.getByText('0:03.0')).toBeTruthy();
  });

  it('reports sync as on for timed lines', () => {
    renderPanel();
    expect(screen.getByText('Sync: On')).toBeTruthy();
  });

  it('shows the local-source hint when nothing is loaded', () => {
    renderPanel({ lyrics: null });
    expect(screen.getByText('No lyrics loaded')).toBeTruthy();
    expect(screen.getByText(/\.lrc, \.srt or \.txt file/)).toBeTruthy();
  });

  it('renders the translation track under a merged bilingual line', () => {
    renderPanel({
      lyrics: {
        lines: [{ startTime: 1, endTime: 3, text: 'original', translation: 'translated' }],
      },
    });
    expect(screen.getByText('original')).toBeTruthy();
    expect(screen.getByText('translated')).toBeTruthy();
  });
});