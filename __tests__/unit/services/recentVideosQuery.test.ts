/**
 * Data-fetching tests for the local build's "recent analyses" list.
 *
 * After Phase 4 the data source is the Flask `analyses` table (via the
 * same-origin `/api/local-cache` proxy), so `fetch` is mocked here rather than
 * Firestore.
 */

import {
  ALL_KEYS_VALUE,
  createInitialRecentVideosPageParam,
  fetchRecentVideosPage,
  mapRecentAnalysisToVideo,
  RECENT_VIDEOS_PAGE_SIZE,
  type RecentAnalysisItem,
} from '@/services/query/recentVideos';

const baseItem: RecentAnalysisItem = {
  audio_id: 'abcd1234efgh',
  model: 'btc-sl',
  filename: 'song.mp3',
  title: 'Song One',
  duration: 185,
  created_at: 100,
  hits: 9,
  bpm: 120,
  keySignature: 'C major',
  timeSignature: 4,
};

const fetchMock = jest.fn();

const okResponse = (items: RecentAnalysisItem[]) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, items, total: items.length }),
  } as unknown as Response);

describe('recentVideos (local cache build)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  it('maps analyses rows into home page cards (audio_id is the videoId)', () => {
    expect(mapRecentAnalysisToVideo(baseItem)).toEqual(
      expect.objectContaining({
        videoId: 'abcd1234efgh',
        title: 'Song One',
        processedAt: 100_000,
        duration: 185,
        bpm: 120,
        keySignature: 'C major',
        usageCount: 9,
      }),
    );
  });

  it('drops rows without an audio_id and rows already in the list', () => {
    expect(mapRecentAnalysisToVideo({ ...baseItem, audio_id: null })).toBeNull();
    expect(
      mapRecentAnalysisToVideo(baseItem, new Set([baseItem.audio_id as string])),
    ).toBeNull();
  });

  it('hides a missing or zero bpm', () => {
    expect(mapRecentAnalysisToVideo({ ...baseItem, bpm: 0 })?.bpm).toBeUndefined();
    expect(mapRecentAnalysisToVideo({ ...baseItem, bpm: null })?.bpm).toBeUndefined();
  });

  it('requests limit+1 on the first page and flags that another page exists', async () => {
    const items = Array.from({ length: RECENT_VIDEOS_PAGE_SIZE + 1 }, (_, index) => ({
      ...baseItem,
      audio_id: `audio-${index}`,
    }));
    fetchMock.mockReturnValueOnce(okResponse(items));

    const page = await fetchRecentVideosPage({
      selectedKey: ALL_KEYS_VALUE,
      pageParam: createInitialRecentVideosPageParam(),
    });

    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toContain(`limit=${RECENT_VIDEOS_PAGE_SIZE + 1}`);
    expect(requested).toContain('offset=0');
    expect(requested).not.toContain('key=');
    expect(page.queryMode).toBe('local');
    expect(page.videos).toHaveLength(RECENT_VIDEOS_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
    expect(page.lastVisible).toBe(RECENT_VIDEOS_PAGE_SIZE);
  });

  it('sets hasMore=false and lastVisible=null when the data is under one page', async () => {
    fetchMock.mockReturnValueOnce(okResponse([baseItem]));

    const page = await fetchRecentVideosPage({
      selectedKey: ALL_KEYS_VALUE,
      pageParam: createInitialRecentVideosPageParam(),
    });

    expect(page.videos).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.lastVisible).toBeNull();
  });

  it('forwards the selected key to the backend and uses the cursor as offset', async () => {
    fetchMock.mockReturnValueOnce(okResponse([]));

    await fetchRecentVideosPage({
      selectedKey: 'A major',
      pageParam: { cursor: 24, mode: 'local', existingVideoIds: ['audio-0'] },
    });

    const requested = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
    expect(requested.searchParams.get('offset')).toBe('24');
    expect(requested.searchParams.get('key')).toBe('A major');
  });

  it('degrades to an empty page instead of throwing when the backend errors', async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as unknown as Response),
    );

    const page = await fetchRecentVideosPage({
      selectedKey: ALL_KEYS_VALUE,
      pageParam: createInitialRecentVideosPageParam(),
    });

    expect(page.videos).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});