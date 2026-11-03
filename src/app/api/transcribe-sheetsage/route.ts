import { NextRequest, NextResponse } from 'next/server';
import { getSheetSageApiUrl } from '@/config/serverBackend';
import { createSafeTimeoutSignal } from '@/utils/environmentUtils';
import type { SheetSageResult } from '@/types/sheetSage';
import { cacheKvSet } from '@/services/cache/localCacheClient';
import { verifyAppCheckRequest } from '@/utils/serverAppCheck';

/**
 * Browser-facing proxy to the standalone Sheet Sage melody backend.
 *
 * Sheet Sage is a purely local service (upstream ships it as a Docker image and
 * this fork expects it at `getSheetSageApiUrl()`, default
 * `http://localhost:8082`). The route shape is the upstream one; the two
 * integrations that no longer exist here were replaced:
 *
 *  - Firebase App Check: `verifyAppCheckRequest` is an offline stub that always
 *    allows the request, so the guard stays in place without a network call.
 *  - Firestore melody cache: results are written to the local SQLite key/value
 *    store (`kv_cache`) through `cacheKvSet`, read back by `/api/melody-cache`.
 *
 * The upstream offload/blob remote-audio branch is gone: this build has no
 * offload pipeline and the client always uploads a `file` field.
 */

export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_SHEETSAGE_BACKEND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SHEETSAGE_HEALTH_TIMEOUT_MS = 20 * 1000;
const MELODY_CACHE_KEY_PREFIX = 'melody:';

const parsedSheetSageBackendTimeoutMs = Number(
  process.env.SHEETSAGE_BACKEND_TIMEOUT_MS || DEFAULT_SHEETSAGE_BACKEND_TIMEOUT_MS,
);
const SHEETSAGE_BACKEND_TIMEOUT_MS = (
  Number.isFinite(parsedSheetSageBackendTimeoutMs)
  && parsedSheetSageBackendTimeoutMs > 0
)
  ? Math.floor(parsedSheetSageBackendTimeoutMs)
  : DEFAULT_SHEETSAGE_BACKEND_TIMEOUT_MS;

function buildBackendUnavailableMessage(message: string): string {
  if (message.toLowerCase().includes('required upstream assets') || message.toLowerCase().includes('asset host')) {
    return 'Sheet Sage backend unavailable: missing upstream assets.';
  }

  return message;
}

function readStringField(formData: FormData, ...names: string[]): string | null {
  for (const name of names) {
    const value = formData.get(name);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getJsonString(payload: unknown, ...names: string[]): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

/**
 * Cache keys accept the YouTube id used upstream and the local audio id
 * (sha256 content hash) this fork derives from an uploaded file.
 */
function isValidVideoId(videoId: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId) || /^[a-f0-9]{64}$/.test(videoId);
}

function normalizeMelodyResultForCache(videoId: string, result: SheetSageResult) {
  const noteEvents = Array.isArray(result.noteEvents)
    ? [...result.noteEvents]
      .filter((note) => (
        typeof note?.onset === 'number'
        && Number.isFinite(note.onset)
        && typeof note?.offset === 'number'
        && Number.isFinite(note.offset)
        && typeof note?.pitch === 'number'
        && Number.isFinite(note.pitch)
        && typeof note?.velocity === 'number'
        && Number.isFinite(note.velocity)
      ))
      .sort((left, right) => (
        left.onset - right.onset
        || left.pitch - right.pitch
        || left.offset - right.offset
      ))
      .map((note) => ({
        onset: note.onset,
        offset: Math.max(note.offset, note.onset),
        pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
        velocity: Math.max(0, Math.min(127, Math.round(note.velocity))),
      }))
    : [];

  return {
    ...result,
    source: 'sheetsage' as const,
    videoId,
    model: 'sheetsage-v0.2-handcrafted-melody-transformer',
    createdAt: new Date().toISOString(),
    noteEvents,
    noteEventCount: noteEvents.length,
    beatTimes: Array.isArray(result.beatTimes)
      ? result.beatTimes.filter((beatTime) => typeof beatTime === 'number' && Number.isFinite(beatTime))
      : [],
    beatsPerMeasure:
      typeof result.beatsPerMeasure === 'number' && Number.isFinite(result.beatsPerMeasure) && result.beatsPerMeasure > 0
        ? result.beatsPerMeasure
        : 4,
    tempoBpm:
      typeof result.tempoBpm === 'number' && Number.isFinite(result.tempoBpm) && result.tempoBpm > 0
        ? result.tempoBpm
        : 120,
  };
}

export async function POST(request: NextRequest) {
  const backendUrl = getSheetSageApiUrl();

  try {
    // App Check guard kept for structural parity; the stub always allows.
    const appCheck = await verifyAppCheckRequest(request);
    if (!appCheck.ok) {
      return NextResponse.json({ success: false, error: appCheck.error }, { status: appCheck.status || 403 });
    }

    const contentType = request.headers.get('content-type') || '';
    const isJsonRequest = contentType.toLowerCase().includes('application/json');
    const requestPayload = isJsonRequest ? await request.json().catch(() => null) : null;
    const formData = isJsonRequest ? null : await request.formData();
    const videoIdField = isJsonRequest
      ? getJsonString(requestPayload, 'videoId')
      : readStringField(formData as FormData, 'videoId');
    const videoId = typeof videoIdField === 'string' ? videoIdField.trim() : '';

    const uploadedFile = formData?.get('file');
    if (!(uploadedFile instanceof File)) {
      return NextResponse.json(
        { success: false, error: 'No audio file provided' },
        { status: 400 },
      );
    }

    const backendFormData = new FormData();
    backendFormData.append('file', uploadedFile, uploadedFile.name || 'audio-upload');

    const response = await fetch(`${backendUrl}/transcribe`, {
      method: 'POST',
      body: backendFormData,
      signal: createSafeTimeoutSignal(SHEETSAGE_BACKEND_TIMEOUT_MS),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: payload?.error || `Sheet Sage backend failed: ${response.status} ${response.statusText}`,
        },
        { status: response.status },
      );
    }

    if (videoId && isValidVideoId(videoId) && payload?.data) {
      try {
        const sanitizedData = normalizeMelodyResultForCache(videoId, payload.data as SheetSageResult);
        const saved = await cacheKvSet(`${MELODY_CACHE_KEY_PREFIX}${videoId}`, sanitizedData);
        if (saved) {
          console.log(`🎻 [API] Cached Sheet Sage melody for ${videoId} (${sanitizedData.noteEventCount} notes)`);
        } else {
          console.warn(`⚠️ [API] Non-critical: local melody cache rejected ${videoId}`);
        }
      } catch (cacheError) {
        console.error('❌ [API] Failed to persist Sheet Sage melody cache:', cacheError);
      }
    }

    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown Sheet Sage error';
    const isFetchFailure = message.toLowerCase().includes('fetch failed');
    const isTimeoutFailure = message.toLowerCase().includes('aborted')
      || message.toLowerCase().includes('timeout');

    return NextResponse.json(
      {
        success: false,
        error: isFetchFailure
          ? 'Could not reach the Sheet Sage backend. Please try again later or contact support if the issue persists.'
          : isTimeoutFailure
            ? `Sheet Sage exceeded the ${Math.round(SHEETSAGE_BACKEND_TIMEOUT_MS / 1000)}s proxy timeout. Increase SHEETSAGE_BACKEND_TIMEOUT_MS or try a shorter audio segment.`
            : message,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const healthRequested = request.nextUrl.searchParams.get('health');
  if (healthRequested === '1' || healthRequested === 'true') {
    const backendUrl = getSheetSageApiUrl();

    try {
      const response = await fetch(`${backendUrl}/health?warmup=true`, {
        method: 'GET',
        signal: createSafeTimeoutSignal(DEFAULT_SHEETSAGE_HEALTH_TIMEOUT_MS),
      });

      const payload = await response.json().catch(() => null);
      const backendError = payload?.error || `Sheet Sage backend health check failed: ${response.status} ${response.statusText}`;
      const normalizedError = buildBackendUnavailableMessage(backendError);

      return NextResponse.json(
        {
          success: response.ok,
          available: response.ok && payload?.assetUnavailable !== true,
          initialized: Boolean(payload?.initialized),
          assetUnavailable: Boolean(payload?.assetUnavailable),
          error: response.ok ? null : normalizedError,
          statusCode: response.status,
          runtime: payload?.runtime ?? null,
        },
        { status: 200 },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown Sheet Sage health error';
      const isFetchFailure = message.toLowerCase().includes('fetch failed');
      const isTimeoutFailure = message.toLowerCase().includes('aborted')
        || message.toLowerCase().includes('timeout');

      return NextResponse.json(
        {
          success: false,
          available: false,
          assetUnavailable: false,
          error: isFetchFailure
            ? 'Could not reach the Sheet Sage backend.'
            : isTimeoutFailure
              ? 'Timed out while checking Sheet Sage backend readiness.'
              : message,
          statusCode: 503,
        },
        { status: 200 },
      );
    }
  }

  return NextResponse.json({
    name: 'Sheet Sage API',
    description: 'Proxies uploaded audio to the standalone Sheet Sage melody backend.',
    endpoint: 'POST /api/transcribe-sheetsage',
  });
}