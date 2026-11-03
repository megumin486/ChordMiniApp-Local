/**
 * App Check verification — disabled for offline operation.
 *
 * The upstream project gated its API routes behind Firebase App Check and
 * verified tokens with `firebase-admin`. This fork runs entirely on the local
 * machine with no Firebase project, so there is no token to verify and no
 * authority to verify it against.
 *
 * The function is kept (same signature, same call sites) so the route handlers
 * stay structurally identical to upstream: it simply always allows the request
 * and never touches the network.
 */

import { NextRequest } from 'next/server';

export interface AppCheckResult {
  /** Whether the request should be allowed through */
  ok: boolean;
  /** HTTP status code to return when `ok` is false */
  status?: number;
  /** Human-readable error message */
  error?: string;
}

export async function verifyAppCheckRequest(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _request: NextRequest,
): Promise<AppCheckResult> {
  // Offline build: no App Check, no firebase-admin, no outbound calls.
  return { ok: true };
}

/** @deprecated Kept for symmetry with upstream; always null offline. */
export async function getServerAppCheckToken(): Promise<string | null> {
  return null;
}