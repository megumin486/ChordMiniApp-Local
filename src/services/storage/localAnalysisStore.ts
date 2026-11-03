/**
 * Local analysis-result store (local replacement for Firestore transcriptions).
 *
 * Phase 3 moved the cache layer into the Flask backend's SQLite (`kv_cache` /
 * `analyses` / `audio_files`). After Phase 4 removed Firebase, the module that
 * used to talk to Firestore directly, `services/firebase/firestoreService.ts`,
 * was replaced by this one:
 *
 *   - Same function names and signatures (getTranscription / saveTranscription /
 *     updateTranscriptionEnrichment / incrementTranscriptionUsage), so call
 *     sites barely change;
 *   - Storage is the backend `kv_cache`, keyed with the original Firestore
 *     document id rule `${videoId}_${beatModel}_${chordModel}` and prefixed
 *     with `transcriptions:` to mark its purpose;
 *   - Browser -> `/api/local-kv` (same-origin proxy) -> Flask `/api/cache/kv`,
 *     entirely on this machine.
 *
 * Every function degrades on failure (returning null / false), matching
 * upstream's "skip when Firebase is not initialized" tolerance: an unavailable
 * cache must not interrupt the analysis flow.
 */

import type { ChordDetectionResult } from '@/services/chord-analysis/chordRecognitionService';
import type { BeatInfo } from '@/services/audio/beatDetectionService';
import type { SheetSageResult } from '@/types/sheetSage';
import { applyEnharmonicCorrection } from '@/utils/chordUtils';
import { synchronizeChords } from '@/utils/chordSynchronization';

// ---------------------------------------------------------------------------
// Types (migrated verbatim from firestoreService, minus the Firebase Timestamp dependency)
// ---------------------------------------------------------------------------

export type RomanNumeralData = {
  analysis: string[];
  keyContext: string;
  temporalShifts?: Array<{
    chordIndex: number;
    targetKey: string;
    romanNumeral: string;
  }>;
};

export type SequenceCorrectionsData = {
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
      atTime?: number;
    }>;
  };
  romanNumerals?: RomanNumeralData | null;
} | null;

export interface TranscriptionData {
  videoId: string;
  title?: string;
  channelTitle?: string;
  thumbnail?: string;
  audioUrl?: string | null;
  beatModel: string;
  chordModel: string;
  beats: BeatInfo[];
  chords: ChordDetectionResult[];
  downbeats?: number[];
  downbeats_with_measures?: { time: number; measureNum: number }[];
  synchronizedChords: { chord: string; beatIndex: number; beatNum?: number }[];
  /** ISO timestamp; upstream used a Firestore Timestamp, local storage does not need one */
  createdAt?: string | null;
  audioDuration?: number;
  totalProcessingTime?: number;
  timeSignature?: number | null;
  bpm?: number | null;
  beatShift?: number;
  keySignature?: string | null;
  keyModulation?: string | null;
  chordCorrections?: Record<string, string> | null;
  sequenceCorrections?: SequenceCorrectionsData;
  correctedChords?: string[] | null;
  originalChords?: string[] | null;
  primaryKey?: string | null;
  modulation?: string | null;
  corrections?: Record<string, string> | null;
  rawResponse?: string | null;
  romanNumerals?: RomanNumeralData | null;
  isPrimaryVariant?: boolean;
  displayPriority?: number | null;
  searchableKeys?: string[];
  usageCount?: number;
  beatDetectionResult?: {
    time_signature?: number;
    bpm?: number;
    beatShift?: number;
    beat_time_range_start?: number;
    paddingCount?: number;
    shiftCount?: number;
  };
}

export interface MelodyTranscriptionData extends SheetSageResult {
  videoId: string;
  model: string;
  createdAt?: string | null;
}

/** Locally the audio is served by `/api/audio/<id>`; the client holds no storage object */
export interface AudioFileData {
  videoId: string;
  audioUrl: string;
  videoUrl?: string | null;
  title: string;
  storagePath?: string;
  videoStoragePath?: string | null;
  fileSize: number;
  videoFileSize?: number;
  duration?: number;
  createdAt?: string | null;
  isStreamUrl?: boolean;
  streamExpiresAt?: number;
}

export interface TranscriptionEnrichmentUpdate {
  title?: string;
  channelTitle?: string;
  thumbnail?: string;
  keySignature?: string | null;
  keyModulation?: string | null;
  chordCorrections?: Record<string, string> | null;
  sequenceCorrections?: SequenceCorrectionsData;
  correctedChords?: string[] | null;
  originalChords?: string[] | null;
  romanNumerals?: RomanNumeralData | null;
}

// ---------------------------------------------------------------------------
// Key names and the KV channel
// ---------------------------------------------------------------------------

const KV_PREFIX = 'transcriptions:';
const REQUEST_TIMEOUT_MS = 8_000;

export const buildTranscriptionDocId = (
  videoId: string,
  beatModel: string,
  chordModel: string,
) => `${videoId}_${beatModel}_${chordModel}`;

const transcriptionKey = (videoId: string, beatModel: string, chordModel: string) =>
  `${KV_PREFIX}${buildTranscriptionDocId(videoId, beatModel, chordModel)}`;

async function kvGet<T>(key: string): Promise<T | null> {
  if (typeof window === 'undefined') return null;
  try {
    const response = await fetch(`/api/local-kv?key=${encodeURIComponent(key)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { success?: boolean; found?: boolean; value?: T };
    if (!payload?.success || !payload.found) return null;
    return (payload.value ?? null) as T | null;
  } catch (error) {
    console.debug('[localAnalysisStore] kv get failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function kvSet(key: string, value: unknown): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const response = await fetch('/api/local-kv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ key, value }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { success?: boolean };
    return Boolean(payload?.success);
  } catch (error) {
    console.debug('[localAnalysisStore] kv set failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Normalization (same logic as the original Firestore version)
// ---------------------------------------------------------------------------

function toPositiveBeatNum(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value > 0 ? value : undefined;
}

function sanitizeSynchronizedChords(
  synchronizedChords: TranscriptionData['synchronizedChords'] | undefined,
): { chord: string; beatIndex: number; beatNum?: number }[] {
  if (!Array.isArray(synchronizedChords)) {
    return [];
  }

  return synchronizedChords
    .filter((item): item is { chord: string; beatIndex: number; beatNum?: number } => (
      Boolean(item)
      && typeof item.chord === 'string'
      && typeof item.beatIndex === 'number'
      && Number.isFinite(item.beatIndex)
      && item.beatIndex >= 0
    ))
    .map((item) => {
      const beatNum = toPositiveBeatNum(item.beatNum);
      return beatNum !== undefined
        ? { chord: item.chord, beatIndex: item.beatIndex, beatNum }
        : { chord: item.chord, beatIndex: item.beatIndex };
    });
}

function rebuildSynchronizedChordsIfNeeded(
  data: TranscriptionData,
): { chord: string; beatIndex: number; beatNum?: number }[] {
  const hasUsableInputs =
    Array.isArray(data.chords) && data.chords.length > 0
    && Array.isArray(data.beats) && data.beats.length > 0;

  if (!hasUsableInputs) {
    return sanitizeSynchronizedChords(data.synchronizedChords);
  }

  const rebuilt = synchronizeChords(data.chords, data.beats);
  return rebuilt.map((item, index) => {
    const beatNum = toPositiveBeatNum(data.beats[index]?.beatNum);
    return beatNum !== undefined
      ? { ...item, beatNum }
      : { chord: item.chord, beatIndex: item.beatIndex };
  });
}

function buildLegacySequenceCorrections(data: TranscriptionData): SequenceCorrectionsData {
  const legacyCorrections = data.chordCorrections ?? data.corrections ?? null;
  const originalSequence =
    data.originalChords
    ?? data.synchronizedChords?.map((item) => item.chord)
    ?? data.chords?.map((item) => item.chord)
    ?? null;

  if (!legacyCorrections || !Array.isArray(originalSequence) || originalSequence.length === 0) {
    return null;
  }

  const correctedSequence = originalSequence.map((chord) =>
    applyEnharmonicCorrection(chord, legacyCorrections),
  );
  const hasAnyCorrection = correctedSequence.some((chord, index) => chord !== originalSequence[index]);

  if (!hasAnyCorrection) {
    return null;
  }

  return {
    originalSequence,
    correctedSequence,
    romanNumerals: data.romanNumerals ?? null,
  };
}

export function normalizeTranscriptionData(data: TranscriptionData): TranscriptionData {
  const normalizedSequenceCorrections =
    data.sequenceCorrections
    ?? (
      Array.isArray(data.originalChords)
      && Array.isArray(data.correctedChords)
      && data.originalChords.length === data.correctedChords.length
        ? {
            originalSequence: data.originalChords,
            correctedSequence: data.correctedChords,
            romanNumerals: data.romanNumerals ?? null,
          }
        : null
    )
    ?? buildLegacySequenceCorrections(data);

  return {
    ...data,
    chords: Array.isArray(data.chords)
      ? data.chords.map((chord) => ({
          ...chord,
          time:
            typeof chord?.time === 'number' && Number.isFinite(chord.time)
              ? chord.time
              : (typeof chord?.start === 'number' && Number.isFinite(chord.start) ? chord.start : 0),
        }))
      : [],
    synchronizedChords: rebuildSynchronizedChordsIfNeeded(data),
    keySignature: data.keySignature ?? data.primaryKey ?? null,
    keyModulation: data.keyModulation ?? data.modulation ?? null,
    chordCorrections: data.chordCorrections ?? data.corrections ?? null,
    correctedChords: data.correctedChords ?? normalizedSequenceCorrections?.correctedSequence ?? null,
    originalChords: data.originalChords ?? normalizedSequenceCorrections?.originalSequence ?? null,
    sequenceCorrections: normalizedSequenceCorrections
      ? {
          ...normalizedSequenceCorrections,
          romanNumerals: normalizedSequenceCorrections.romanNumerals ?? data.romanNumerals ?? null,
        }
      : null,
    romanNumerals: data.romanNumerals ?? normalizedSequenceCorrections?.romanNumerals ?? null,
    usageCount:
      typeof data.usageCount === 'number' && Number.isFinite(data.usageCount) && data.usageCount >= 0
        ? data.usageCount
        : 0,
    beatDetectionResult: data.beatDetectionResult ?? (
      (data.timeSignature !== undefined && data.timeSignature !== null)
      || (data.bpm !== undefined && data.bpm !== null)
        ? {
            time_signature: data.timeSignature ?? undefined,
            bpm: data.bpm ?? undefined,
            beatShift: data.beatShift ?? undefined,
          }
        : undefined
    ),
  };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function getTranscription(
  videoId: string,
  beatModel: string,
  chordModel: string,
): Promise<TranscriptionData | null> {
  if (!videoId) return null;
  const stored = await kvGet<TranscriptionData>(
    transcriptionKey(videoId, beatModel, chordModel),
  );
  return stored ? normalizeTranscriptionData(stored) : null;
}

export async function saveTranscription(
  transcriptionData: Omit<TranscriptionData, 'createdAt'>,
): Promise<boolean> {
  if (!transcriptionData?.videoId) return false;
  const record: TranscriptionData = {
    ...transcriptionData,
    createdAt: new Date().toISOString(),
  };
  return kvSet(
    transcriptionKey(record.videoId, record.beatModel, record.chordModel),
    record,
  );
}

export async function updateTranscriptionEnrichment(
  videoId: string,
  beatModel: string,
  chordModel: string,
  enrichment: TranscriptionEnrichmentUpdate,
): Promise<boolean> {
  if (!videoId) return false;

  const existing = await getTranscription(videoId, beatModel, chordModel);
  if (!existing) {
    // Same as upstream: with no cache row there is nothing to update
    return false;
  }

  const sanitizedEnrichment = Object.fromEntries(
    Object.entries({
      title: enrichment.title,
      channelTitle: enrichment.channelTitle,
      thumbnail: enrichment.thumbnail,
      keySignature: enrichment.keySignature,
      primaryKey: enrichment.keySignature,
      keyModulation: enrichment.keyModulation,
      modulation: enrichment.keyModulation,
      chordCorrections: enrichment.chordCorrections,
      corrections: enrichment.chordCorrections,
      sequenceCorrections: enrichment.sequenceCorrections,
      correctedChords:
        enrichment.correctedChords ?? enrichment.sequenceCorrections?.correctedSequence ?? null,
      originalChords:
        enrichment.originalChords ?? enrichment.sequenceCorrections?.originalSequence ?? null,
      romanNumerals: enrichment.romanNumerals,
    }).filter(([, value]) => value !== undefined),
  ) as Partial<TranscriptionData>;

  return kvSet(
    transcriptionKey(videoId, beatModel, chordModel),
    { ...existing, ...sanitizedEnrichment },
  );
}

export async function incrementTranscriptionUsage(
  videoId: string,
  beatModel: string,
  chordModel: string,
): Promise<boolean> {
  if (!videoId) return false;

  const existing = await getTranscription(videoId, beatModel, chordModel);
  if (!existing) return false;

  return kvSet(transcriptionKey(videoId, beatModel, chordModel), {
    ...existing,
    usageCount: (existing.usageCount ?? 0) + 1,
  });
}

/**
 * Locally there is no "this track's audio is already cached in Firebase Storage"
 * path: audio is content-addressed in the backend `audio_files` table and the
 * client only holds `/api/audio/<id>`, with no videoId -> audioId reverse index.
 * This therefore always returns null and the caller runs the normal upload /
 * analysis flow (same as the behaviour after Phase 3 when Firebase is unset).
 */
export async function getCachedAudioFile(videoId: string): Promise<AudioFileData | null> {
  void videoId;
  return null;
}