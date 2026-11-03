import type { AnalysisResult, BeatInfo, ChordDetectionResult } from '@/types/audioAnalysis';
import type { RestoredAnalysis } from '@/services/cache/localCacheClient';
import { synchronizeChords } from '@/utils/chordSynchronization';

/**
 * Restores the raw payload from the backend cache into a front-end `AnalysisResult`.
 *
 * The cache stores raw model output (a chords array plus a beats array in
 * seconds), while the page consumes `BeatInfo[]` / `synchronizedChords[]`. That
 * conversion used to happen inside `analyzeAudioWithRateLimit()`; it is
 * replicated here so "open last analysis" and a fresh analysis render
 * identically.
 *
 * Note `beatNum` on the beats: the original flow cycles 1..N by time_signature
 * and this matches it, otherwise the bar lines and the chord grid would
 * misalign.
 */
export function buildAnalysisResultFromCache(
  restored: RestoredAnalysis,
): AnalysisResult | null {
  const chordSource = Array.isArray(restored.chords) ? restored.chords : [];
  const beatTimes = Array.isArray(restored.beats) ? restored.beats : [];

  if (chordSource.length === 0 || beatTimes.length === 0) {
    return null;
  }

  const timeSignature =
    typeof restored.timeSignature === 'string'
      ? Number.parseInt(restored.timeSignature.split('/')[0], 10) || 4
      : 4;

  const chords: ChordDetectionResult[] = chordSource
    .filter(
      (chord) =>
        chord &&
        typeof chord.start === 'number' &&
        typeof chord.end === 'number' &&
        chord.start < chord.end,
    )
    .map((chord) => ({
      chord: chord.chord,
      start: chord.start,
      end: chord.end,
      time: chord.start,
      confidence: typeof chord.confidence === 'number' ? chord.confidence : 1,
    }));

  const beats: BeatInfo[] = beatTimes
    .filter((time) => typeof time === 'number' && Number.isFinite(time) && time >= 0)
    .map((time, index) => ({
      time,
      strength: 0.8,
      beatNum: (index % timeSignature) + 1,
    }));

  if (chords.length === 0 || beats.length === 0) {
    return null;
  }

  const synchronized = synchronizeChords(chords, beats).filter(
    (entry) =>
      entry &&
      typeof entry.beatIndex === 'number' &&
      entry.beatIndex >= 0 &&
      entry.beatIndex < beats.length &&
      typeof entry.chord === 'string',
  );

  return {
    chords,
    audioId: restored.audioId,
    beats,
    downbeats: Array.isArray(restored.downbeats) ? restored.downbeats : [],
    synchronizedChords: synchronized,
    beatModel: restored.beatModel || undefined,
    chordModel: restored.chordModel || undefined,
    audioDuration: typeof restored.duration === 'number' ? restored.duration : undefined,
    beatDetectionResult: {
      time_signature: timeSignature,
      bpm: typeof restored.bpm === 'number' ? restored.bpm : undefined,
    },
  };
}
