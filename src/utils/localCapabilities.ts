/**
 * Capability flags for the local-only build.
 *
 * ChordMini no longer talks to any external AI service, so every
 * credential-backed capability is compiled out. Components used to ask
 * `useApiKeys()` for this information; they now read these constants, which
 * keeps the UI copy honest without an API-key store to maintain.
 */

/**
 * YouTube search / URL analysis would need the YouTube Data API and yt-dlp,
 * both of which this build removed (FEATURE_SCOPE items 1-2). The search box
 * used to stay on screen and fail on every keystroke, so it is now gated on
 * this flag and replaced by the local-upload entry point.
 */
export const SEARCH_AVAILABLE = false;

/** Shown where the search box used to be. */
export const SEARCH_UNAVAILABLE_MESSAGE =
  'Searching YouTube is not available in this local-only build — upload an audio file instead';

/** Lyrics transcription would need Music.ai, which this build does not include. */
export const LYRICS_TRANSCRIPTION_AVAILABLE = false;

/** Shown wherever lyrics transcription used to be advertised as an option. */
export const LYRICS_TRANSCRIPTION_UNAVAILABLE_MESSAGE =
  'Lyrics transcription (Music.ai) is not available in this local-only build';