/**
 * App Check token: offline placeholder implementation.
 *
 * Upstream attached an `X-Firebase-AppCheck` header to every BFF request and
 * verified it server-side with `firebase-admin`. This fork runs fully locally
 * with no Firebase project, so there is neither a token nor a verifier.
 *
 * Function names and signatures are preserved, so call sites (apiService /
 * beatDetectionService / sheetSageTranscriptionClient / offloadUploadService
 * etc.) keep their shape: it always returns `null` and callers skip the header.
 * No network, no dependencies.
 */

export async function getAppCheckTokenForApi(): Promise<string | null> {
  return null;
}