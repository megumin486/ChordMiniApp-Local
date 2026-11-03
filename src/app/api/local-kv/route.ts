import { NextResponse } from 'next/server';
import { cacheKvDelete, cacheKvGet, cacheKvSet } from '@/services/cache/localCacheClient';

/**
 * Browser-facing proxy for the local SQLite key/value store.
 *
 * Why a separate route: `localCacheClient` is server-only (it talks to the Flask
 * backend directly). The transcription store is used from client hooks, so the
 * browser needs a same-origin hop.
 *
 * GET    /api/local-kv?key=K   -> { success, found, value }
 * POST   /api/local-kv         -> body { key, value, ttlSeconds? } -> { success, saved }
 * DELETE /api/local-kv         -> body { keys: string[] }         -> { success, deleted }
 *
 * Values are JSON documents stored in the backend `kv_cache` table; nothing
 * leaves the machine.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function readKeyFromUrl(request: Request): string {
  return (new URL(request.url).searchParams.get('key') || '').trim();
}

export async function GET(request: Request) {
  const key = readKeyFromUrl(request);
  if (!key) {
    return NextResponse.json({ success: false, error: 'missing key' }, { status: 400 });
  }

  const value = await cacheKvGet<unknown>(key);
  return NextResponse.json({ success: true, found: value !== null, value });
}

export async function POST(request: Request) {
  let body: { key?: unknown; value?: unknown; ttlSeconds?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid json' }, { status: 400 });
  }

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) {
    return NextResponse.json({ success: false, error: 'missing key' }, { status: 400 });
  }

  const ttlSeconds =
    typeof body.ttlSeconds === 'number' && Number.isFinite(body.ttlSeconds) && body.ttlSeconds > 0
      ? Math.floor(body.ttlSeconds)
      : undefined;

  const saved = await cacheKvSet(key, body.value ?? null, ttlSeconds);
  return NextResponse.json({ success: saved, saved });
}

export async function DELETE(request: Request) {
  let body: { keys?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid json' }, { status: 400 });
  }

  const keys = Array.isArray(body.keys)
    ? body.keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    : [];

  if (keys.length === 0) {
    return NextResponse.json({ success: false, error: 'missing keys' }, { status: 400 });
  }

  const deleted = await cacheKvDelete(keys);
  return NextResponse.json({ success: deleted > 0, deleted });
}