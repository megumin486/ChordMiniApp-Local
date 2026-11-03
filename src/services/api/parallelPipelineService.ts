/**
 * In-process audio cache (remnant of the old Cloud Run + Firebase Storage pipeline).
 *
 * Upstream handed the downloaded audio to both Cloud Run and Firebase Storage and
 * used this map to avoid a second download. Phase 2 deleted the offload path and
 * Phase 4 removed Firebase, leaving only "reuse the Blob for the same videoId
 * within 10 minutes". `/api/audio-duration` and `audioAnalysisService` still query
 * it with the original signature; a miss does not affect the analysis flow.
 *
 * No outbound requests and no Firebase dependency.
 */

const AUDIO_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedAudioEntry {
  blob: Blob;
  timestamp: number;
}

const audioFileCache = new Map<string, CachedAudioEntry>();

/** Remembers a decoded/downloaded audio Blob for later steps on the same videoId. */
export function cacheAudioFile(videoId: string, blob: Blob): void {
  if (!videoId) return;
  audioFileCache.set(videoId, { blob, timestamp: Date.now() });
}

export function getCachedAudioFile(videoId: string): Blob | null {
  const cached = audioFileCache.get(videoId);
  if (!cached) return null;

  if (Date.now() - cached.timestamp < AUDIO_CACHE_TTL_MS) {
    return cached.blob;
  }

  audioFileCache.delete(videoId);
  return null;
}

export function getCachedAudioMeta(videoId: string): {
  present: boolean;
  ageMs?: number;
  size?: number;
  timestamp?: number;
  expiresInMs?: number;
} {
  const cached = audioFileCache.get(videoId);
  if (!cached) return { present: false };

  const ageMs = Date.now() - cached.timestamp;
  return {
    present: true,
    ageMs,
    size: cached.blob.size,
    timestamp: cached.timestamp,
    expiresInMs: Math.max(0, AUDIO_CACHE_TTL_MS - ageMs),
  };
}

export function cleanupBackgroundResults(_maxAgeMs: number = 300000): void {
  const now = Date.now();
  for (const [videoId, cached] of audioFileCache.entries()) {
    if (now - cached.timestamp > AUDIO_CACHE_TTL_MS) {
      audioFileCache.delete(videoId);
    }
  }
}