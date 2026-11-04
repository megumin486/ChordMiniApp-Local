/**
 * Keeps local lyrics next to their cached analysis.
 *
 * An analysis record only knows chords, beats and metadata, so reopening a
 * cached analysis used to lose the lyrics that were loaded back then. Parsed
 * lyrics are stored in the local key/value store under `lyrics:<audioId>`; when
 * an entry is missing the tags are re-read from the stored audio file instead.
 * Both paths stay on this machine: the kv store is the backend SQLite cache and
 * the audio comes from the same-origin `/api/audio/<id>` proxy.
 */
import type { LyricsData } from '@/types/musicAiTypes';
import { dropCreditLines, extractEmbeddedLyrics, mergeBilingualLines } from '@/utils/lyrics/localLyrics';

const CACHE_KEY_PREFIX = 'lyrics:';
const DOCUMENT_KIND = 'local-lyrics';

/** Lyrics plus the label shown in the picker (file name or "embedded tags"). */
export interface CachedLyrics {
  data: LyricsData;
  name: string | null;
}

export const lyricsCacheKey = (audioId: string): string => `${CACHE_KEY_PREFIX}${audioId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Accepts only documents that look like LyricsData, so a stale or foreign
 * entry in the kv store cannot break the player.
 */
export function isLyricsData(value: unknown): value is LyricsData {
  if (!isRecord(value) || !Array.isArray(value.lines)) return false;
  return value.lines.every(
    (line) =>
      isRecord(line) &&
      typeof line.text === 'string' &&
      typeof line.startTime === 'number' &&
      typeof line.endTime === 'number',
  );
}

/** Reads either the wrapped document or a bare LyricsData written by an older build. */
function readCachedLyrics(value: unknown): CachedLyrics | null {
  if (isRecord(value) && value.kind === DOCUMENT_KIND) {
    if (!isLyricsData(value.data)) return null;
    return { data: value.data, name: typeof value.name === 'string' ? value.name : null };
  }
  if (isLyricsData(value)) return { data: value, name: null };
  return null;
}

/** Stores the parsed lyrics for an audio id. Returns false when nothing was saved. */
export async function saveLyricsForAudio(
  audioId: string,
  lyrics: LyricsData,
  name?: string | null,
): Promise<boolean> {
  if (!audioId || !Array.isArray(lyrics.lines) || lyrics.lines.length === 0) return false;
  try {
    const response = await fetch('/api/local-kv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: lyricsCacheKey(audioId),
        value: {
          kind: DOCUMENT_KIND,
          name: name ?? null,
          data: { ...lyrics, lines: mergeBilingualLines(dropCreditLines(lyrics.lines)) },
        },
      }),
    });
    if (!response.ok) return false;
    const data: { success?: boolean } = await response.json();
    return Boolean(data.success);
  } catch {
    return false;
  }
}

/** Reads the lyrics stored for an audio id, or null when there are none. */
export async function loadLyricsForAudio(audioId: string): Promise<CachedLyrics | null> {
  if (!audioId) return null;
  try {
    const response = await fetch(
      `/api/local-kv?key=${encodeURIComponent(lyricsCacheKey(audioId))}`,
      { cache: 'no-store' },
    );
    if (!response.ok) return null;
    const document: { found?: boolean; value?: unknown } = await response.json();
    if (!document.found) return null;
    const cached = readCachedLyrics(document.value);
    if (!cached) return null;
    // Cached entries written before the credit-line filter still carry credits,
    // and entries written before bilingual merging still carry the two tracks
    // as separate lines.
    const lines = mergeBilingualLines(dropCreditLines(cached.data.lines));
    if (lines.length === 0) return null;
    return { ...cached, data: { ...cached.data, lines } };
  } catch {
    return null;
  }
}

/** Last resort for cached audio: read the lyric tags straight from the stored bytes. */
export async function extractLyricsFromAudioUrl(
  audioUrl: string,
  filename?: string | null,
): Promise<LyricsData | null> {
  if (!audioUrl) return null;
  try {
    const response = await fetch(audioUrl, { cache: 'no-store' });
    if (!response.ok) return null;
    const blob = await response.blob();
    const file = new File([blob], filename || 'audio', {
      type: blob.type || 'application/octet-stream',
    });
    return await extractEmbeddedLyrics(file);
  } catch {
    return null;
  }
}