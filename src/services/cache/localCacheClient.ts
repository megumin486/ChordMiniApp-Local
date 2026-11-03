/**
 * Local cache client (server-side only).
 *
 * Phase 3 replaced the Firestore/Firebase-Storage cache with the Flask
 * backend's SQLite store. Every helper here talks to `/api/cache/*` or
 * `/api/audio/*` on the Python backend, so nothing leaves the machine.
 *
 * All functions are failure-tolerant: a cache miss and a cache outage look the
 * same to the caller (`null`), which keeps the analysis pipeline working even
 * when the cache is empty or the backend is briefly unavailable.
 */

import { getPythonApiUrl } from '@/config/serverBackend';

const REQUEST_TIMEOUT_MS = 10_000;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(`${getPythonApiUrl()}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[localCache] ${path} -> HTTP ${response.status}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    console.warn(`[localCache] ${path} failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Key/value cache (key detection results, misc documents)
// ---------------------------------------------------------------------------

export async function cacheKvGet<T>(key: string): Promise<T | null> {
  const payload = await requestJson<{ success: boolean; found: boolean; value: T | null }>(
    `/api/cache/kv?key=${encodeURIComponent(key)}`,
  );

  if (!payload?.success || !payload.found) {
    return null;
  }

  return payload.value;
}

export async function cacheKvSet(
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<boolean> {
  const payload = await requestJson<{ success: boolean }>('/api/cache/kv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, ttlSeconds }),
  });

  return Boolean(payload?.success);
}

export async function cacheKvDelete(keys: string[]): Promise<number> {
  const payload = await requestJson<{ success: boolean; deleted: number }>('/api/cache/kv', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });

  return payload?.deleted ?? 0;
}

// ---------------------------------------------------------------------------
// Stats / recent analyses
// ---------------------------------------------------------------------------

export interface LocalCacheStats {
  dbPath: string;
  dbBytes: number;
  analyses: number;
  ttlDays: number;
  audio: {
    files: number;
    bytes: number;
    megabytes: number;
    budget_megabytes: number;
    directory: string;
  };
}

export async function getCacheStats(): Promise<LocalCacheStats | null> {
  return requestJson<LocalCacheStats>('/api/cache/stats');
}

export interface RecentAnalysis {
  cache_key: string;
  kind: string;
  audio_id: string | null;
  model: string | null;
  filename: string | null;
  title: string;
  duration: number | null;
  created_at: number;
  last_used_at: number;
  hits: number;
  audioUrl: string | null;
  /** Tempo (the backend extracts it from the chord payload's beatDetectionResult.bpm) */
  bpm?: number | null;
  /** Authoritative key backfilled by detect-key (e.g. `A major`), null if undetected */
  keySignature?: string | null;
  /** Time signature numerator (stored as `time_signature`), null when unknown */
  timeSignature?: number | null;
}

export async function getRecentAnalyses(limit = 20): Promise<RecentAnalysis[]> {
  const payload = await requestJson<{ success: boolean; items: RecentAnalysis[] }>(
    `/api/cache/recent?limit=${limit}`,
  );

  return payload?.items ?? [];
}

/**
 * Page through the backend's "recent analyses" list.
 *
 * The backend folds the analysis rows down to one entry per audio file
 * (chords / harmony / beats share an `audio_id`), so `offset` counts songs,
 * not rows. `keySignature` filters server-side — pass `null`/`'all'` for "any".
 */
export async function getRecentAnalysesPage({
  limit = 12,
  offset = 0,
  keySignature = null,
}: {
  limit?: number;
  offset?: number;
  keySignature?: string | null;
} = {}): Promise<RecentAnalysis[]> {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(limit, 100))),
    offset: String(Math.max(0, offset)),
  });
  if (keySignature && keySignature !== 'all') {
    params.set('key', keySignature);
  }

  const payload = await requestJson<{ success: boolean; items: RecentAnalysis[] }>(
    `/api/cache/recent?${params.toString()}`,
  );

  return payload?.items ?? [];
}

/**
 * Backfill the authoritative key onto an audio's cached analysis rows.
 *
 * detect-key runs after chord recognition, so the "recent analyses" list would
 * otherwise never have a key to show or filter on.
 */
export async function setAnalysisKey(
  audioId: string,
  keySignature: string,
): Promise<number> {
  if (!audioId || !keySignature) return 0;

  const payload = await requestJson<{ success: boolean; updated: number }>(
    '/api/cache/analysis-key',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioId, keySignature }),
    },
  );

  return payload?.updated ?? 0;
}

/**
 * Raw analysis data from the cache, used by "open last analysis" to rebuild the
 * page without re-running the models.
 *
 * There used to be a `runCacheMaintenance()` calling `/api/cache/maintenance`
 * (TTL 30 days / LRU 2048MB budget). It only reclaimed entries that were already
 * due for eviction, which normal use never produced, so the "clean" button
 * appeared inert. Phase 5 deleted that endpoint and its client wrapper: expiry
 * reclamation now runs automatically from `cache_service.ensure_ready()` on
 * backend startup.
 */
export interface RestoredAnalysis {
  audioId: string;
  audioUrl: string;
  filename: string | null;
  duration: number | null;
  chords: Array<{ start: number; end: number; chord: string; confidence: number }>;
  beats: number[];
  downbeats: number[];
  bpm: number | null;
  timeSignature: string | null;
  beatModel: string | null;
  chordModel: string | null;
  harmony: Record<string, unknown> | null;
  createdAt: number | null;
}

export async function getCachedAnalysis(audioId?: string): Promise<RestoredAnalysis | null> {
  const path = audioId
    ? `/api/cache/restore?audioId=${encodeURIComponent(audioId)}`
    : '/api/cache/restore';

  return requestJson<RestoredAnalysis>(path);
}

/** Unconditionally clear the whole local cache: analyses + kv_cache + audio bytes and registry. */
export interface ClearAllResult {
  removedAnalyses: number;
  removedKvEntries: number;
  removedAudioFiles: number;
  removedAudioRows: number;
  freedBytes: number;
}

export async function clearAllCache(): Promise<ClearAllResult | null> {
  const payload = await requestJson<{ success: boolean } & ClearAllResult>(
    '/api/cache/clear',
    { method: 'POST' },
  );

  if (!payload?.success) {
    return null;
  }

  return {
    removedAnalyses: payload.removedAnalyses ?? 0,
    removedKvEntries: payload.removedKvEntries ?? 0,
    removedAudioFiles: payload.removedAudioFiles ?? 0,
    removedAudioRows: payload.removedAudioRows ?? 0,
    freedBytes: payload.freedBytes ?? 0,
  };
}

/** Delete one audio: bytes + registry row + all analysis rows for that audio. */
export async function deleteCachedAudio(audioId: string): Promise<boolean> {
  if (!audioId) return false;

  const payload = await requestJson<{ success: boolean }>(
    `/api/audio/${encodeURIComponent(audioId)}`,
    { method: 'DELETE' },
  );

  return Boolean(payload?.success);
}

// ---------------------------------------------------------------------------
// Audio store
// ---------------------------------------------------------------------------

export interface StoredAudio {
  audioId: string;
  size: number;
  ext: string;
  duplicated: boolean;
  audioUrl: string;
}

/**
 * Persist an uploaded file into the backend's content-addressed audio store so
 * the analysis stays replayable after the page's blob URL goes away.
 */
export async function storeAudioInCache(file: File): Promise<StoredAudio | null> {
  try {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const response = await fetch(`${getPythonApiUrl()}/api/audio/store`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      console.warn(`[localCache] audio store -> HTTP ${response.status}`);
      return null;
    }

    const payload = (await response.json()) as { success: boolean } & StoredAudio;
    return payload.success ? payload : null;
  } catch (error) {
    console.warn('[localCache] audio store failed:', error instanceof Error ? error.message : error);
    return null;
  }
}