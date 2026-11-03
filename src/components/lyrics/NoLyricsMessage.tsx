import React from 'react';
import type { LyricTextColors } from '@/components/lyrics/lyricsTheme';

interface NoLyricsMessageProps {
  error?: string;
  textColors: LyricTextColors;
}

/**
 * NoLyricsMessage component - extracted from LeadSheetDisplay
 *
 * Shows the empty state when no synced lyric sheet is available. The local-only
 * build ships no lyrics transcription service, so the copy explains what the
 * user can still do instead of pointing at an API key or workflow dashboard.
 */
export const NoLyricsMessage: React.FC<NoLyricsMessageProps> = ({
  error,
  textColors
}) => {
  const errorMessage = error || 'No lyrics available for this song';

  return (
    <div className="lead-sheet-container p-4 rounded-lg shadow" style={{ backgroundColor: textColors.background }}>
      <div className="text-center p-8" style={{ color: textColors.unplayed }}>
        <div className="mb-4 text-xl font-semibold">Lyrics Unavailable</div>
        <div className="text-base">{errorMessage}</div>
        <div className="mt-6 text-sm opacity-75">
          This may be due to:
          <ul className="list-disc list-inside mt-2 text-left max-w-md mx-auto">
            <li>This build does not include a lyrics transcription service</li>
            <li>The song having no vocals (instrumental tracks never have lyrics)</li>
            <li>No synced lyric sheet being available locally for this track</li>
          </ul>
        </div>
        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-blue-700 font-medium">What you can still do:</p>
          <ul className="list-disc list-inside mt-2 text-left max-w-md mx-auto text-blue-600">
            <li>Keep using the chord grid, Roman numerals and beat map</li>
            <li>Try another audio file that ships with a synced lyric sheet</li>
            <li>Check the browser console for detailed error messages</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default NoLyricsMessage;