/**
 * `parallelPipelineService` is now a pure in-process audio buffer (the Firebase
 * upload pipeline was removed in Phase 4). These tests cover cache reads, TTL
 * expiry and cleanup semantics.
 */

type Service = typeof import('@/services/api/parallelPipelineService');

const load = async (): Promise<Service> => {
  const service = await import('@/services/api/parallelPipelineService');
  service.cleanupBackgroundResults();
  return service;
};

describe('parallelPipelineService (local in-process cache)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a cached blob by videoId together with its TTL metadata', async () => {
    const service = await load();
    const blob = new Blob(['audio-bytes'], { type: 'audio/mp4' });

    service.cacheAudioFile('video-1', blob);

    expect(service.getCachedAudioFile('video-1')).toBe(blob);
    const meta = service.getCachedAudioMeta('video-1');
    expect(meta).toEqual(
      expect.objectContaining({ present: true, size: blob.size }),
    );
    // Remaining TTL is `AUDIO_CACHE_TTL_MS - ageMs`, so it is always just under 10 minutes
    expect(meta.expiresInMs).toBeGreaterThan(590000);
    expect(meta.expiresInMs).toBeLessThanOrEqual(600000);
  });

  it('returns null with present:false on a miss', async () => {
    const service = await load();

    expect(service.getCachedAudioFile('missing')).toBeNull();
    expect(service.getCachedAudioMeta('missing')).toEqual(
      expect.objectContaining({ present: false }),
    );
  });

  it('treats entries past the TTL as expired and drops them', async () => {
    const service = await load();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    service.cacheAudioFile('video-1', new Blob(['x']));

    nowSpy.mockReturnValue(1_000 + 10 * 60 * 1000 + 1);

    expect(service.getCachedAudioFile('video-1')).toBeNull();
    expect(service.getCachedAudioMeta('video-1')).toEqual(
      expect.objectContaining({ present: false }),
    );
  });

  it('cleanupBackgroundResults drops only expired entries and keeps fresh ones', async () => {
    const service = await load();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    service.cacheAudioFile('video-1', new Blob(['x']));

    nowSpy.mockReturnValue(1_000 + 60 * 60 * 1000); // one hour later
    service.cacheAudioFile('video-2', new Blob(['y']));

    service.cleanupBackgroundResults();

    expect(service.getCachedAudioFile('video-1')).toBeNull();
    expect(service.getCachedAudioFile('video-2')).not.toBeNull();
  });
});