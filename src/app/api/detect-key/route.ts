import { NextRequest, NextResponse } from 'next/server';
import { cacheKvGet, cacheKvSet, setAnalysisKey } from '@/services/cache/localCacheClient';
import crypto from 'crypto';
import { sanitizeLegacyCorrections, sanitizeSequenceCorrections } from '@/utils/keyDetectionCorrections';
import { estimateKeySignatureFromChords } from '@/utils/chordUtils';

export const maxDuration = 240; // 4 minutes for key detection processing

// Resolve the Python backend base URL. Server-only env vars, never exposed to
// the browser. Matches the convention used by the other backend routes.
function resolvePythonApiUrl(): string {
  return (
    process.env.PYTHON_API_URL ||
    process.env.NEXT_PUBLIC_PYTHON_API_URL ||
    'http://localhost:5001'
  ).replace(/\/+$/, '');
}

// Key detection prompt version. Retained for cache-key compatibility so
// existing cached entries are not invalidated; the prompt itself is no longer
// used because the local harmony engine replaced Gemini.
// Cache version: since v6 the response carries
// keySource/chordKey/keyConflict/modulations, and correctedChords uses the
// engine's equal-length array directly (old entries expire via the version).
// v7: borrowed degrees use conventional spelling (bII/bIII/bVI/bVII, never
// #I/#II/#v).
const KEY_DETECTION_PROMPT_VERSION = 'v7-roman-spelling';

// Define types for chord data
interface ChordData {
  chord: string;
  time?: number;
}

// Helper function to generate cache key for key detection
function generateKeyDetectionCacheKey(chords: ChordData[], includeEnharmonicCorrection: boolean = false, includeRomanNumerals: boolean = false): string {
  // Create a more precise and unique representation
  const chordString = chords
    .map(chord => `${chord.time?.toFixed(3) || 0}:${chord.chord || chord}`)
    .join('|');

  // Put flags at the beginning to ensure they're not truncated
  const keyString = `prompt:${KEY_DETECTION_PROMPT_VERSION}_enharmonic:${includeEnharmonicCorrection}_roman:${includeRomanNumerals}_${chordString}`;

  // Use SHA-256 hash for better uniqueness and consistent length
  const hash = crypto.createHash('sha256').update(keyString).digest('hex');

  // Return first 32 characters of hash for reasonable cache key length
  return hash.substring(0, 32);
}

// Define types for key detection result
interface KeyDetectionResult {
  primaryKey: string;
  modulation?: string | null;
  originalChords?: string[];
  correctedChords?: string[];
  corrections?: Record<string, string>;
  // Harmony engine v4 metadata
  keySource?: string;
  chordKey?: string;
  keyConflict?: boolean;
  // Key confidence in 0..1. The backend always had it but it was never
  // forwarded; item 27 (prompt export) needs it (FEATURE_SCOPE 10.5 keeps
  // unique information). Old cache entries lack the field, meaning unknown.
  keyConfidence?: number | null;
  modulations?: Array<{
    fromKey: string;
    toKey: string;
    atIndex: number;
    isRelative?: boolean;
    source?: string;
  }>;
  sequenceCorrections?: {
    originalSequence: string[];
    correctedSequence: string[];
    keyAnalysis?: {
      sections: Array<{
        startIndex: number;
        endIndex: number;
        key: string;
        chords: string[];
      }>;
      modulations?: Array<{
        fromKey: string;
        toKey: string;
        atIndex: number;
      }>;
    };
  } | null;
  romanNumerals?: {
    analysis: string[];
    keyContext: string;
    sections?: Array<{
      startIndex: number;
      endIndex: number;
      key: string;
    }>;
    temporalShifts?: Array<{
      chordIndex: number;
      targetKey: string;
      romanNumeral: string;
    }>;
  } | null;
  rawResponse?: string;
  fromCache?: boolean;
  fromHeuristicFallback?: boolean;
}

interface KeyDetectionCacheEntry {
  primaryKey: string;
  modulation?: string | null;
  corrections?: Record<string, string>;
  sequenceCorrections?: KeyDetectionResult['sequenceCorrections'];
  romanNumerals?: KeyDetectionResult['romanNumerals'];
  keyConfidence?: number | null;
  keySource?: string;
  chordKey?: string;
  keyConflict?: boolean;
  modulations?: KeyDetectionResult['modulations'];
}

function removeUndefinedFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => removeUndefinedFields(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, fieldValue]) => fieldValue !== undefined)
        .map(([key, fieldValue]) => [key, removeUndefinedFields(fieldValue)])
    ) as T;
  }

  return value;
}

function buildLegacyCorrections(
  sequenceCorrections: KeyDetectionResult['sequenceCorrections']
): Record<string, string> {
  const legacyCorrections: Record<string, string> = {};

  if (!sequenceCorrections?.originalSequence || !sequenceCorrections.correctedSequence) {
    return legacyCorrections;
  }

  sequenceCorrections.originalSequence.forEach((original: string, index: number) => {
    const corrected = sequenceCorrections.correctedSequence[index];
    if (original !== corrected) {
      legacyCorrections[original] = corrected;
    }
  });

  return legacyCorrections;
}

function buildCorrectedChordSequence(
  chordNames: string[],
  corrections: Record<string, string>,
  sequenceCorrections: KeyDetectionResult['sequenceCorrections']
): string[] {
  if (sequenceCorrections?.correctedSequence?.length) {
    return sequenceCorrections.correctedSequence;
  }

  return chordNames.map((chord) => corrections[chord] || chord);
}

function buildHeuristicKeyDetectionResult(params: {
  chordNames: string[];
  includeEnharmonicCorrection: boolean;
  rawResponse?: string;
}): KeyDetectionResult {
  const { chordNames, includeEnharmonicCorrection, rawResponse } = params;
  const estimatedKey = estimateKeySignatureFromChords(chordNames);

  return {
    primaryKey: estimatedKey.keySignature,
    modulation: null,
    originalChords: includeEnharmonicCorrection ? chordNames : undefined,
    correctedChords: includeEnharmonicCorrection ? chordNames : undefined,
    corrections: includeEnharmonicCorrection ? {} : undefined,
    sequenceCorrections: null,
    romanNumerals: null,
    // The heuristic fallback has no audio key CNN, so report null explicitly
    // rather than inventing a number.
    keyConfidence: null,
    keySource: 'heuristic',
    rawResponse,
    fromHeuristicFallback: true,
  };
}

// Helper function to check cache for key detection.
// Phase 3: reads from the local SQLite cache in the Python backend instead of
// Firestore. A cache miss and a cache outage both yield `null`, so detection
// simply runs again.
async function checkKeyDetectionCache(cacheKey: string): Promise<KeyDetectionCacheEntry | null> {
  try {
    const data = await cacheKvGet<KeyDetectionCacheEntry>(`keyDetections:${cacheKey}`);

    if (data) {
      console.log('Found cached key detection (local SQLite cache)');
      return data;
    }

    return null;
  } catch (error) {
    console.error('Error checking key detection cache:', error);
    return null;
  }
}

// Helper function to save key detection to cache (local SQLite, see above).
async function saveKeyDetectionToCache(cacheKey: string, keyResult: KeyDetectionResult): Promise<void> {
  try {
    const cacheData: KeyDetectionCacheEntry = {
      primaryKey: keyResult.primaryKey,
      modulation: keyResult.modulation ?? null,
      corrections: keyResult.corrections || {},
      // Ensure sequence corrections are properly stored
      sequenceCorrections: keyResult.sequenceCorrections ? {
        originalSequence: keyResult.sequenceCorrections.originalSequence || [],
        correctedSequence: keyResult.sequenceCorrections.correctedSequence || [],
        keyAnalysis: keyResult.sequenceCorrections.keyAnalysis || undefined
      } : null,
      // Ensure Roman numerals are properly stored
      romanNumerals: keyResult.romanNumerals ? {
        analysis: keyResult.romanNumerals.analysis || [],
        keyContext: keyResult.romanNumerals.keyContext || '',
        temporalShifts: keyResult.romanNumerals.temporalShifts || [],
        // Section keys: modulated tracks need these to show the new key, otherwise the
        sections: keyResult.romanNumerals.sections || []
      } : null,
      // Item 27 export needs: confidence, key source and modulation detail.
      // Old entries lack these fields and read back as undefined, which the
      // exporter treats as unknown, so KEY_DETECTION_PROMPT_VERSION is NOT
      // bumped (bumping it would invalidate the whole cache).
      keyConfidence: keyResult.keyConfidence ?? null,
      keySource: keyResult.keySource,
      chordKey: keyResult.chordKey,
      keyConflict: keyResult.keyConflict,
      modulations: keyResult.modulations || [],
    };

    const saved = await cacheKvSet(
      `keyDetections:${cacheKey}`,
      JSON.parse(JSON.stringify(removeUndefinedFields(cacheData))),
    );
    if (saved) {
      console.log('✅ Key detection saved to local cache');
    } else {
      console.warn('⚠️ Key detection was not persisted to the local cache');
    }
  } catch (error) {
    console.error('❌ Error saving key detection to cache:', error);
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        name: error.name,
        stack: error.stack?.substring(0, 500)
      });
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    // geminiApiKey accepted for backward compatibility with existing clients
    // but no longer used: analysis is fully local since Phase 2.
    const { chords, includeEnharmonicCorrection = false, bypassCache = false, includeRomanNumerals = false, audioId = null } = await request.json();

    // API call tracking for optimization monitoring
    console.log('🔍 [API] Key detection request:', {
      chordsCount: chords?.length || 0,
      includeEnharmonicCorrection,
      includeRomanNumerals,
      bypassCache
    });

    if (!chords || !Array.isArray(chords) || chords.length === 0) {
      return NextResponse.json(
        { error: 'Invalid chord progression data' },
        { status: 400 }
      );
    }

    // Generate cache key (include enharmonic and Roman numeral flags in cache key)
    const cacheKey = generateKeyDetectionCacheKey(chords, includeEnharmonicCorrection, includeRomanNumerals);
    const chordNames = chords.map((chord: ChordData) => {
      if (typeof chord === 'string') {
        return chord;
      }
      return chord.chord || String(chord);
    });

    // Check cache first (unless bypassed for testing)
    console.log('🔍 [CACHE] Checking cache for key:', cacheKey.substring(0, 20) + '...');
    const cachedResult = bypassCache ? null : await checkKeyDetectionCache(cacheKey);
    if (cachedResult && !bypassCache) {
      console.log('✅ [CACHE] Cache hit - returning cached result');
      // Extract chord names for fallback if enharmonic correction data is missing
      const sanitizedSequenceCorrections = cachedResult.sequenceCorrections
        ? sanitizeSequenceCorrections(chordNames, cachedResult.sequenceCorrections)
        : null;
      const normalizedCorrections = {
        ...buildLegacyCorrections(sanitizedSequenceCorrections),
        ...sanitizeLegacyCorrections(chordNames, cachedResult.corrections || {})
      };
      const correctedChords = includeEnharmonicCorrection
        ? buildCorrectedChordSequence(chordNames, normalizedCorrections, sanitizedSequenceCorrections)
        : undefined;

      return NextResponse.json({
        primaryKey: cachedResult.primaryKey,
        modulation: cachedResult.modulation,
        // Keep API compatibility by deriving these fields from request/cached analysis when needed.
        originalChords: includeEnharmonicCorrection ? chordNames : undefined,
        correctedChords,
        corrections: normalizedCorrections,
        // ENHANCED: Include sequence corrections from cache with proper structure
        sequenceCorrections: sanitizedSequenceCorrections,
        // Include Roman numeral analysis from cache
        romanNumerals: cachedResult.romanNumerals || null,
        // Key confidence/source/modulations only exist in cache entries written
        // after this change; older ones read back as undefined and the exporter
        // treats that as unknown (no cache version bump, to keep the cache).
        keyConfidence: cachedResult.keyConfidence ?? null,
        keySource: cachedResult.keySource,
        chordKey: cachedResult.chordKey,
        keyConflict: cachedResult.keyConflict,
        modulations: cachedResult.modulations,
        fromCache: true,
      });
    } else {
      console.log('❌ [CACHE] Cache miss - proceeding to the local harmony engine');
    }

    // -----------------------------------------------------------------
    // Local harmony engine (replaces Gemini)
    // -----------------------------------------------------------------
    // FEATURE_SCOPE Phase 2: key detection, Roman numerals, enharmonic
    // correction and modulation markers are produced by the Python backend's
    // /api/analyze-harmony endpoint (music21 + harte-library). No external
    // service is contacted.
    const harmonyBaseUrl = resolvePythonApiUrl();

    let localResult: {
      primaryKey?: string;
      modulation?: string | null;
      correctedChords?: string[];
      corrections?: Record<string, string>;
      sequenceCorrections?: KeyDetectionResult['sequenceCorrections'];
      romanNumerals?: KeyDetectionResult['romanNumerals'];
      keyMethod?: string;
      keyConfidence?: number;
      keySource?: string;
      chordKey?: string;
      keyConflict?: boolean;
      modulations?: KeyDetectionResult['modulations'];
    };

    try {
      const response = await fetch(`${harmonyBaseUrl}/api/analyze-harmony`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chords,
          includeRomanNumerals,
          includeEnharmonicCorrection,
          // Content-addressed local audio id: the backend runs its madmom key CNN on
          ...(audioId ? { audioId } : {}),
        }),
        signal: AbortSignal.timeout(maxDuration * 1000),
      });

      if (!response.ok) {
        throw new Error(`analyze-harmony returned ${response.status}`);
      }

      localResult = await response.json();
      console.log('✅ [HARMONY] Received result from local engine:', {
        primaryKey: localResult.primaryKey,
        keyMethod: localResult.keyMethod,
        keyConfidence: localResult.keyConfidence,
      });
    } catch (harmonyError) {
      console.error('Local harmony engine failed, using heuristic fallback:', harmonyError);
      return NextResponse.json(buildHeuristicKeyDetectionResult({
        chordNames,
        includeEnharmonicCorrection,
      }));
    }

    if (!localResult.primaryKey || localResult.primaryKey === 'Unknown') {
      return NextResponse.json(buildHeuristicKeyDetectionResult({
        chordNames,
        includeEnharmonicCorrection,
      }));
    }

    // Normalize into the existing KeyDetectionResult shape and run the same
    // sanitizers that previously guarded Gemini output.
    const sanitizedSequence = localResult.sequenceCorrections
      ? sanitizeSequenceCorrections(chordNames, localResult.sequenceCorrections)
      : null;

    const legacyCorrections = {
      ...buildLegacyCorrections(sanitizedSequence),
      ...sanitizeLegacyCorrections(chordNames, localResult.corrections || {}),
    };

    // The engine's correctedChords already matches the input length (including
    // N.C. placeholders), so prefer it directly and avoid reintroducing the
    // misalignment the legacy client-side rebuild caused
    const engineCorrectedChords =
      Array.isArray(localResult.correctedChords) &&
      localResult.correctedChords.length === chordNames.length
        ? localResult.correctedChords
        : null;

    const correctedChords = includeEnharmonicCorrection
      ? (engineCorrectedChords ?? buildCorrectedChordSequence(chordNames, legacyCorrections, sanitizedSequence))
      : undefined;

    const result: KeyDetectionResult = {
      primaryKey: localResult.primaryKey,
      modulation: localResult.modulation ?? null,
      originalChords: includeEnharmonicCorrection ? chordNames : undefined,
      correctedChords,
      corrections: legacyCorrections,
      sequenceCorrections: sanitizedSequence,
      romanNumerals: localResult.romanNumerals || null,
      keySource: localResult.keySource,
      chordKey: localResult.chordKey,
      keyConflict: localResult.keyConflict,
      keyConfidence: localResult.keyConfidence ?? null,
      modulations: localResult.modulations,
      fromCache: false,
      fromHeuristicFallback: false,
    };

    await saveKeyDetectionToCache(cacheKey, result);
    // Backfill the authoritative key onto this audio's analyses rows: the home
    // page folds "recent" entries by audio_id and reads the key from here
    // (detect-key finishes after chord recognition).
    if (audioId && result.primaryKey) {
      const updated = await setAnalysisKey(audioId, result.primaryKey);
      console.debug(`[detect-key] backfilled key "${result.primaryKey}" onto ${updated} analysis row(s)`);
    }
    return NextResponse.json(result);

  } catch (error) {
    console.error('Error detecting key:', error);
    return NextResponse.json(
      { error: 'Failed to detect musical key' },
      { status: 500 }
    );
  }
}
