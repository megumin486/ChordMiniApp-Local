import { NextResponse } from 'next/server';
import {
  clearAllCache,
  deleteCachedAudio,
  getCacheStats,
  getRecentAnalyses,
  getRecentAnalysesPage,
} from '@/services/cache/localCacheClient';

/**
 * Browser-facing view of the local SQLite cache.
 *
 * GET    /api/local-cache                     -> { stats, recent } (default 8, upload page panel)
 * GET    /api/local-cache?limit=&offset=&key= -> { items, total } (paged recent list)
 * POST   /api/local-cache                     -> clear the whole local cache (analyses + kv + audio)
 * DELETE /api/local-cache?audioId=<id>        -> delete one audio (including its analysis rows)
 *
 * The Python backend owns the database; this route only proxies it so the
 * client keeps talking to a single origin. `key` filters on the authoritative
 * key that detect-key backfills onto the audio's analysis rows.
 *
 * Note the POST semantics changed in Phase 5: it used to call
 * `/api/cache/maintenance`, which reclaimed already-expired entries by TTL
 * (30 days) and LRU budget (2048MB). Normal use never produced any, so the
 * "clean" button appeared inert. It now clears unconditionally; the maintenance
 * endpoint is gone (expiry reclamation now runs automatically on backend
 * startup).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const paged = params.has('limit') || params.has('offset') || params.has('key');

  if (paged) {
    const limit = Number.parseInt(params.get('limit') || '12', 10);
    const offset = Number.parseInt(params.get('offset') || '0', 10);
    const key = params.get('key');

    const items = await getRecentAnalysesPage({
      limit: Number.isFinite(limit) ? limit : 12,
      offset: Number.isFinite(offset) ? offset : 0,
      keySignature: key,
    });

    return NextResponse.json({ success: true, items, total: items.length });
  }

  const [stats, recent] = await Promise.all([getCacheStats(), getRecentAnalyses(8)]);

  return NextResponse.json({
    success: true,
    available: Boolean(stats),
    stats,
    recent,
  });
}

export async function POST() {
  const result = await clearAllCache();

  return NextResponse.json({
    success: Boolean(result),
    result,
    error: result ? undefined : 'local cache service unavailable',
  });
}

export async function DELETE(request: Request) {
  const audioId = new URL(request.url).searchParams.get('audioId') || '';

  if (!audioId) {
    return NextResponse.json(
      { success: false, error: 'audioId is required' },
      { status: 400 },
    );
  }

  const deleted = await deleteCachedAudio(audioId);

  return NextResponse.json(
    { success: deleted, audioId, error: deleted ? undefined : 'delete failed' },
    { status: deleted ? 200 : 502 },
  );
}
