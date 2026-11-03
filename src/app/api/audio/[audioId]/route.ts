import { NextRequest } from 'next/server';
import { getPythonApiUrl } from '@/config/serverBackend';

/**
 * Local audio playback proxy: GET /api/audio/<audioId>
 *
 * The bytes live in the Flask backend at `data/audio/<sha[:2]>/<sha><ext>` (see
 * `/api/audio/<audio_id>` in `python_backend/blueprints/cache/routes.py`), but
 * the browser's `<audio>` element and the links in "recent" both use
 * same-origin relative paths, which 404 on port 3000 because Next had no such
 * route.
 *
 * This proxies them so the browser only talks to port 3000, following the same
 * "the browser never hits 5001 directly" convention as `/api/local-cache` and
 * `/api/local-kv`.
 *
 * The Range header must be forwarded verbatim: when the user drags the progress
 * bar `<audio>` issues `bytes=...` range requests, and dropping it degrades to a
 * whole-file download that stalls on long audio.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AUDIO_ID_PATTERN = /^[0-9a-f]{8,128}$/;

function passThroughHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'last-modified',
    'etag',
  ]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function proxy(request: NextRequest, audioId: string): Promise<Response> {
  if (!AUDIO_ID_PATTERN.test(audioId)) {
    return Response.json({ success: false, error: 'invalid audio id' }, { status: 400 });
  }

  const range = request.headers.get('range');
  const upstreamUrl = `${getPythonApiUrl()}/api/audio/${audioId}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: range ? { Range: range } : undefined,
      cache: 'no-store',
      // Audio streams can be long: rely on the runtime default timeout, no signal
    });
  } catch (error) {
    console.warn(
      `[audio-proxy] ${audioId.slice(0, 12)} upstream failed:`,
      error instanceof Error ? error.message : error,
    );
    return Response.json(
      { success: false, error: 'local audio service unavailable' },
      { status: 502 },
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    return Response.json(
      { success: false, error: `audio not found (${upstream.status})` },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: passThroughHeaders(upstream),
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ audioId: string }> },
): Promise<Response> {
  const { audioId } = await context.params;
  return proxy(request, audioId);
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ audioId: string }> },
): Promise<Response> {
  const { audioId } = await context.params;
  return proxy(request, audioId);
}
