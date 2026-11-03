import { useEffect } from 'react';
import { YOUTUBE_PLAYBACK_AVAILABLE } from '@/utils/localCapabilities';

/**
 * Custom hook to set YouTube URLs immediately for fast frame loading
 * Extracted from the main page component to isolate YouTube setup logic
 */
export const useYouTubeSetup = (
  videoId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setAudioProcessingState: React.Dispatch<React.SetStateAction<any>>
) => {
  useEffect(() => {
    // Local-only build: never build YouTube URLs. Without them no player is
    // mounted, so opening a legacy /analyze/<id> URL cannot reach YouTube.
    if (!YOUTUBE_PLAYBACK_AVAILABLE) {
      return;
    }

    if (videoId) {
      // Set YouTube URLs immediately without waiting for API calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setAudioProcessingState((prev: any) => ({
        ...prev,
        youtubeEmbedUrl: `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${window.location.origin}`,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`
      }));

    }
  }, [videoId, setAudioProcessingState]);
};
