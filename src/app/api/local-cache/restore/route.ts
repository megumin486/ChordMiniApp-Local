import { NextResponse } from 'next/server';
import { getCachedAnalysis } from '@/services/cache/localCacheClient';

/**
 * "Open last analysis": hand the cached chords / beats to the browser without
 * re-running any model.
 *
 * GET /api/local-cache/restore                 -> the most recent reopenable analysis
 * GET /api/local-cache/restore?audioId=<id>    -> one specific track
 *
 * The response shape matches the backend `/api/cache/restore`; it returns 404
 * when nothing is cached, and the client falls back to asking for a
 * re-analysis.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const audioId = new URL(request.url).searchParams.get('audioId') || undefined;

  const restored = await getCachedAnalysis(audioId);

  if (!restored) {
    return NextResponse.json(
      { success: false, error: 'no cached analysis available' },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, ...restored });
}
