/**
 * API Configuration for ChordMini
 *
 * This file centralizes API endpoint configuration and routing logic.
 * ML services (chord recognition, beat detection) are routed to the Python backend (Google Cloud Run)
 * while other endpoints remain on the Vercel frontend.
 * Audio extraction stays on the frontend service layer: production uses browser yt-dlp
 * with server finalization, localhost uses local yt-dlp, and yt-mp3-go is rollback-only.
 *
 * Server-side backend routing configuration.
 * Backend service URLs are intentionally resolved from server-only environment variables.
 */

import { getPythonApiUrl, getSongformerApiUrl, getSheetSageApiUrl, getFrontendBaseUrl } from '@/config/serverBackend';

// Backend URLs - Centralized configuration using environment variables
// NOTE: This constant uses process.env and is suitable for server-side code (API routes, SSR)
// For client-side code, use getBackendUrlsAsync() to get runtime configuration
export const BACKEND_URLS = {
  PYTHON_BACKEND: getPythonApiUrl(),

  SONGFORMER_BACKEND: getSongformerApiUrl(),
  SHEETSAGE_BACKEND: getSheetSageApiUrl(),

  VERCEL_FRONTEND: getFrontendBaseUrl(),
} as const;

// Endpoint routing configuration
// Only endpoints that still exist in the local-only build are listed here.
// Removed: audio extraction / YouTube search / lyrics / chatbot / key
// validation / Sheet Sage / segmentation (see FEATURE_SCOPE).
export const API_ROUTES = {
  // ML services - proxy to the local Python backend
  RECOGNIZE_CHORDS: '/api/recognize-chords',
  RECOGNIZE_CHORDS_BTC_PL: '/api/recognize-chords-btc-pl',
  RECOGNIZE_CHORDS_BTC_SL: '/api/recognize-chords-btc-sl',
  DETECT_BEATS: '/api/detect-beats',
  DETECT_KEY: '/api/detect-key',
  ANALYZE_HARMONY: '/api/analyze-harmony',

  // Local metadata
  MODEL_INFO: '/api/model-info',
  DOCS: '/api/docs',

  // Legacy endpoints that no longer have a route handler in the local-only
  // build. Kept as path constants so call sites still type-check; the
  // corresponding features (YouTube search / audio extraction) are disabled
  // at the service layer, which never reaches these paths.
  LEGACY_SEARCH_YOUTUBE: '/api/search-youtube',
  LEGACY_EXTRACT_AUDIO: '/api/extract-audio',
} as const;

/**
 * Get the full URL for an API endpoint
 * @param endpoint - The endpoint key from API_ROUTES
 * @returns Full URL for the endpoint
 */
export function getApiUrl(endpoint: keyof typeof API_ROUTES): string {
  return API_ROUTES[endpoint];
}

/**
 * Check if an endpoint is routed to the external backend
 * @param endpoint - The endpoint key from API_ROUTES
 * @returns True if the endpoint uses external backend
 */
export function isExternalBackendEndpoint(endpoint: keyof typeof API_ROUTES): boolean {
  const url = API_ROUTES[endpoint];
  return url.startsWith('http') && !url.includes(BACKEND_URLS.VERCEL_FRONTEND);
}

/**
 * Default fetch options for API requests
 */
export const DEFAULT_FETCH_OPTIONS: RequestInit = {
  headers: {
    'Content-Type': 'application/json',
  },
};

/**
 * Enhanced fetch options for external backend requests
 */
export const EXTERNAL_BACKEND_FETCH_OPTIONS: RequestInit = {
  ...DEFAULT_FETCH_OPTIONS,
  mode: 'cors',
  credentials: 'omit', // Don't send cookies to external backend
};

/**
 * Make an API request with proper routing and error handling
 * @param endpoint - The endpoint key from API_ROUTES
 * @param options - Fetch options
 * @returns Promise with the response
 */
export async function apiRequest(
  endpoint: keyof typeof API_ROUTES,
  options: RequestInit = {}
): Promise<Response> {
  const url = getApiUrl(endpoint);
  const isExternal = isExternalBackendEndpoint(endpoint);
  
  const fetchOptions: RequestInit = {
    ...(isExternal ? EXTERNAL_BACKEND_FETCH_OPTIONS : DEFAULT_FETCH_OPTIONS),
    ...options,
  };
  
  try {


    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      console.error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : '';
    if (errorName !== 'AbortError') {
      console.error(`API request error for ${url}:`, error);
    }
    throw error;
  }
}

/**
 * Make a POST request to an API endpoint
 * @param endpoint - The endpoint key from API_ROUTES
 * @param data - Request body data
 * @param options - Additional fetch options (e.g., signal for timeout)
 * @returns Promise with the response
 */
export async function apiPost(
  endpoint: keyof typeof API_ROUTES,
  data: Record<string, unknown>,
  options: RequestInit = {}
): Promise<Response> {
  return apiRequest(endpoint, {
    method: 'POST',
    body: JSON.stringify(data),
    ...options,
  });
}

/**
 * Make a GET request to an API endpoint
 * @param endpoint - The endpoint key from API_ROUTES
 * @returns Promise with the response
 */
export async function apiGet(
  endpoint: keyof typeof API_ROUTES
): Promise<Response> {
  return apiRequest(endpoint, {
    method: 'GET',
  });
}
