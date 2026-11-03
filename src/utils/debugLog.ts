/**
 * Local-only debug logger (Phase 2 diagnostics for the offline build).
 *
 * Posts JSON-serialisable payloads to `/api/debug-log`, which appends them as
 * JSONL to `/tmp/chordmini-debug.log` on the machine running Next.js. The same
 * payload is mirrored to the browser console so DevTools shows the timeline.
 *
 * Never throws, never blocks: all failures are swallowed.
 */

const ENDPOINT = '/api/debug-log';
const MAX_STRING = 400;
const MAX_ARRAY = 120;
const MAX_DEPTH = 3;

let counter = 0;

function truncateString(value: string): string {
  if (value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}...[+${value.length - MAX_STRING} chars]`;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '[function]';

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array:${value.length}]`;
    const head = value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ARRAY) head.push(`...[+${value.length - MAX_ARRAY} items]`);
    return head;
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[object]';
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitize(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

export function dbg(tag: string, data?: Record<string, unknown>): void {
  const payload = {
    tag,
    seq: ++counter,
    data: data ? (sanitize(data) as Record<string, unknown>) : undefined,
  };

  try {
    // eslint-disable-next-line no-console
    console.log('[dbg]', tag, payload.data ?? '');
  } catch {
    /* ignore */
  }

  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
