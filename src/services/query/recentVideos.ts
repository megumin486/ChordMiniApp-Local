/**
 * Home page "recent analyses" list, backed by the local SQLite cache.
 *
 * Phase 4 removed Firebase/Firestore, so the old transcription collection query
 * had no data source. Data now comes from the Flask backend's `analyses` table
 * via the same-origin Next route `/api/local-cache` (the browser only talks to
 * port 3000, never 5001 directly, avoiding CORS and proxy issues):
 *
 *   - The backend folds the chords / harmony / beats rows of one track by
 *     `audio_id`, so `videoId` here is really the local audio id
 *     (`/api/audio/<id>` plays directly);
 *   - The key comes from the `key_signature` column that detect-key backfills,
 *     so key filtering happens in the backend (`?key=A major`) rather than by
 *     comparing strings in the client;
 *   - Paging uses the folded row offset `offset`; `lastVisible` is where the
 *     next page starts.
 */

export interface RecentAnalysisItem {
  audio_id: string | null;
  model: string | null;
  filename: string | null;
  title: string;
  duration: number | null;
  created_at: number;
  hits: number;
  bpm?: number | null;
  keySignature?: string | null;
  timeSignature?: number | null;
}

export interface TranscribedVideo {
  /** Locally this is the audio content hash (audio_id) */
  videoId: string;
  title?: string;
  processedAt: number;
  duration?: number;
  beatModel?: string;
  bpm?: number;
  timeSignature?: number;
  keySignature?: string;
  usageCount?: number;
}

export type RecentVideosQueryMode = 'local';

export interface RecentVideosPageParam {
  /** Offset over the folded rows; null means the first page */
  cursor: number | null;
  mode: RecentVideosQueryMode | null;
  existingVideoIds: string[];
}

export interface RecentVideosPage {
  videos: TranscribedVideo[];
  /** Offset of the next page (= position after the last row of this page) */
  lastVisible: number | null;
  hasMore: boolean;
  queryMode: RecentVideosQueryMode;
}

export const RECENT_VIDEOS_PAGE_SIZE = 12;
export const ALL_KEYS_VALUE = 'all';

export const createInitialRecentVideosPageParam = (): RecentVideosPageParam => ({
  cursor: null,
  mode: null,
  existingVideoIds: [],
});

export function mapRecentAnalysisToVideo(
  item: RecentAnalysisItem,
  existingVideoIds: Set<string> = new Set(),
): TranscribedVideo | null {
  const audioId = item.audio_id;
  if (!audioId || existingVideoIds.has(audioId)) {
    return null;
  }

  return {
    videoId: audioId,
    title: item.title || `Audio ${audioId.slice(0, 8)}`,
    processedAt: (item.created_at ?? 0) * 1000,
    duration: item.duration ?? undefined,
    beatModel: item.model ?? undefined,
    bpm: typeof item.bpm === 'number' && item.bpm > 0 ? item.bpm : undefined,
    timeSignature: item.timeSignature ?? undefined,
    keySignature: item.keySignature || undefined,
    usageCount: item.hits,
  };
}

async function fetchRecentAnalyses(params: {
  limit: number;
  offset: number;
  keySignature: string | null;
}): Promise<RecentAnalysisItem[]> {
  const search = new URLSearchParams({
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.keySignature && params.keySignature !== ALL_KEYS_VALUE) {
    search.set('key', params.keySignature);
  }

  try {
    const response = await fetch(`/api/local-cache?${search.toString()}`, { cache: 'no-store' });
    if (!response.ok) {
      console.warn(`[recentVideos] /api/local-cache -> HTTP ${response.status}`);
      return [];
    }
    const payload = (await response.json()) as { success?: boolean; items?: RecentAnalysisItem[] };
    return payload?.items ?? [];
  } catch (error) {
    console.warn('[recentVideos] failed to load recent analyses:', error instanceof Error ? error.message : error);
    return [];
  }
}

export async function fetchRecentVideosPage({
  selectedKey,
  pageParam,
  pageSize = RECENT_VIDEOS_PAGE_SIZE,
}: {
  selectedKey: string;
  pageParam: RecentVideosPageParam;
  pageSize?: number;
}): Promise<RecentVideosPage> {
  const offset = Math.max(0, pageParam.cursor ?? 0);
  const existingVideoIds = new Set(pageParam.existingVideoIds);

  // Fetch one extra row to know whether another page exists
  const items = await fetchRecentAnalyses({
    limit: pageSize + 1,
    offset,
    keySignature: selectedKey,
  });

  const videos = items
    .map((item) => mapRecentAnalysisToVideo(item, existingVideoIds))
    .filter((video): video is TranscribedVideo => video !== null)
    .slice(0, pageSize);

  const hasMore = items.length > pageSize;

  return {
    videos,
    lastVisible: hasMore ? offset + pageSize : null,
    hasMore,
    queryMode: 'local',
  };
}