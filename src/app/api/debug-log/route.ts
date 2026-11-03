import { NextRequest, NextResponse } from 'next/server';
import { appendFile, mkdir, truncate } from 'fs/promises';
import path from 'path';

/**
 * Local-only debug sink (Phase 2).
 *
 * POST  body: { tag, seq?, data? }  -> appends one JSONL line
 * GET                               -> returns the log path
 * DELETE                            -> truncates the log
 *
 * The log lives on the machine running Next.js (WSL: /tmp/chordmini-debug.log),
 * so it can be read from the shell even when the browser console is unavailable.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG_DIR = process.env.CHORDMINI_DEBUG_DIR || '/tmp';
const LOG_PATH = path.join(LOG_DIR, 'chordmini-debug.log');

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = { tag: 'unparseable-body' };
  }

  const entry = { ts: new Date().toISOString(), ...(body as Record<string, unknown>) };

  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    return NextResponse.json({ ok: true, path: LOG_PATH });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, path: LOG_PATH });
}

export async function DELETE() {
  try {
    await truncate(LOG_PATH, 0);
    return NextResponse.json({ ok: true, cleared: LOG_PATH });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
