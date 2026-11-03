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

/**
 * Lyrics themselves ARE available in this build, but only from local sources:
 * a lyric file the user uploads (.lrc / .srt / .txt / .yaml) or lyric tags
 * already embedded in the audio file. Nothing is fetched from the network.
 */
export const LOCAL_LYRICS_AVAILABLE = true;

/** Shown wherever lyrics are advertised, so the copy matches the local-only build. */
export const LOCAL_LYRICS_HINT =
  'Lyrics are local-only here: upload a lyric file (.lrc, .srt, .txt) next to your audio, or use the lyric tags already embedded in your audio file.';

/** Lyrics translation would need Gemini, which this build does not include. */
export const LYRICS_TRANSLATION_AVAILABLE = false;

/**
 * YouTube playback wiring.
 *
 * This build has no YouTube feature, but the legacy `/analyze/<id>` route is
 * still reachable by direct URL, and it used to wire `react-player` YouTube
 * URLs as soon as an id was present — an outbound request on a build that
 * advertises itself as offline. Every writer and the render sites now check
 * this flag, so no player is ever mounted.
 */
export const YOUTUBE_PLAYBACK_AVAILABLE = false;