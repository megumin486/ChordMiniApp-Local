import { AnalyzeAudioFileOptions } from '@/services/audio/audioProcessingService';
import { getTranscription, TranscriptionData } from '@/services/storage/localAnalysisStore';
import { apiPost } from '@/config/api';
import { LyricsData } from '@/types/musicAiTypes';
// Browser yt-dlp service removed: YouTube extraction dropped in the local-only
// build (FEATURE_SCOPE items 1-2).

// Types for the service
interface ErrorWithSuggestion extends Error {
  suggestion?: string;
}

type BeatDetectorType = 'auto' | 'madmom' | 'beat-transformer';
type ChordDetectorType = 'chord-cnn-lstm' | 'btc-sl' | 'btc-pl';

interface AnalysisResult {
  chords: Array<{chord: string, time: number}>;
  beats: Array<{time: number, beatNum?: number}>;
  downbeats: number[];
  downbeats_with_measures: number[];
  synchronizedChords: Array<{chord: string, beatIndex: number, beatNum?: number}>;
  beatModel: string;
  chordModel: string;
  audioDuration: number;
  beatDetectionResult: {
    time_signature?: number;
    bpm?: number;
    beatShift?: number;
  };
}

interface AudioProcessingState {
  isExtracting: boolean;
  isDownloading: boolean;
  isExtracted: boolean;
  isAnalyzing: boolean;
  isAnalyzed: boolean;
  audioUrl: string | null;
  videoUrl: string | null;
  youtubeEmbedUrl: string | null;
  fromCache: boolean;
  fromFirestoreCache: boolean;
  error: string | null;
  suggestion?: string | null;
  // Browser yt-dlp queue fields removed: YouTube extraction is disabled in the
  // local-only build (FEATURE_SCOPE items 1-2). Fields kept as plain `unknown`
  // so external state snapshots still type-check.
  queueStatus?: unknown;
  queuePosition?: number | null;
  estimatedWaitSeconds?: number | null;
  leaseId?: string | null;
}

interface ProcessingContextType {
  stage: string;
  progress: number;
  setStage: (stage: string) => void;
  setProgress: (progress: number) => void;
  setStatusMessage: (message: string) => void;
  startProcessing: () => void;
  completeProcessing: () => void;
  failProcessing: (message: string) => void;
}

export interface AudioProcessingServiceDependencies {
  // State setters
  setAudioProcessingState: (updater: (prev: AudioProcessingState) => AudioProcessingState) => void;
  setAnalysisResults: (results: AnalysisResult) => void;
  setDuration: (duration: number) => void;
  setShowExtractionNotification: (show: boolean) => void;
  setLyrics: (lyrics: LyricsData) => void;
  setShowLyrics: (show: boolean) => void;
  setHasCachedLyrics: (cached: boolean) => void;
  setActiveTab: (tab: 'beatChordMap' | 'guitarChords' | 'pianoVisualizer') => void;
  setIsTranscribingLyrics: (transcribing: boolean) => void;
  setLyricsError: (error: string | null) => void;

  // Processing context
  processingContext: ProcessingContextType;

  // Audio processing service
  analyzeAudioFromService: (
    audioUrl: string,
    beatDetector: BeatDetectorType,
    chordDetector: ChordDetectorType,
    options?: AnalyzeAudioFileOptions
  ) => Promise<AnalysisResult>;

  // Refs and state
  audioRef: React.RefObject<HTMLAudioElement | null>;
  extractionLockRef: React.MutableRefObject<boolean>;
  beatDetectorRef: React.MutableRefObject<BeatDetectorType>;
  chordDetectorRef: React.MutableRefObject<ChordDetectorType>;

  // URL parameters
  videoId: string;
  titleFromSearch: string | null;
  durationFromSearch: string | null;
  channelFromSearch: string | null;
  thumbnailFromSearch: string | null;

  // Current state values
  audioProcessingState: AudioProcessingState;
  beatDetector: BeatDetectorType;
  chordDetector: ChordDetectorType;
  progress: number;
  lyrics: LyricsData | null; // Current lyrics state for confirmation check

  // Request cancellation & staleness control
  requestId: string;
  abortSignal?: AbortSignal;
  isRequestStillCurrent: (id: string) => boolean;

  // Optional session-local transcription snapshot helpers
  loadTranscriptionSnapshot?: (
    beatDetector: BeatDetectorType,
    chordDetector: ChordDetectorType
  ) => Promise<TranscriptionData | Omit<TranscriptionData, 'createdAt'> | null>;
  setTranscriptionSnapshot?: (data: Omit<TranscriptionData, 'createdAt'> | TranscriptionData) => void;
  onLyricsTranscribed?: (lyrics: LyricsData) => void;
}

/**
 * Enhanced audio analysis function that integrates with processing context
 * Lines 595-739 from original component
 */
export const handleAudioAnalysis = async (deps: AudioProcessingServiceDependencies): Promise<AnalysisResult | undefined> => {
  const {
    audioProcessingState,
    setAudioProcessingState,
    setAnalysisResults,
    setDuration,
    processingContext,
    analyzeAudioFromService,
    beatDetectorRef,
    chordDetectorRef,
    videoId,
    titleFromSearch,
    channelFromSearch,
    thumbnailFromSearch,
  } = deps;

  // Get current model values from refs to ensure we have the latest values
  const currentBeatDetector = beatDetectorRef.current;
  const currentChordDetector = chordDetectorRef.current;

  // Debug: Verify we're using the correct models
  // console.log(`🎯 Analysis starting: Using ${currentBeatDetector} + ${currentChordDetector} models`);
  // console.log(`🔍 Model state verification: state beatDetector="${deps.beatDetector}", state chordDetector="${deps.chordDetector}"`);
  // console.log(`🔍 Model ref verification: ref beatDetector="${beatDetectorRef.current}", ref chordDetector="${chordDetectorRef.current}"`);

  let cachedData: TranscriptionData | Omit<TranscriptionData, 'createdAt'> | null = null;

  try {
    cachedData = deps.loadTranscriptionSnapshot
      ? await deps.loadTranscriptionSnapshot(currentBeatDetector, currentChordDetector)
      : await getTranscription(videoId, currentBeatDetector, currentChordDetector);

    if (cachedData) {
      deps.setTranscriptionSnapshot?.(cachedData);
      // Found cached results, loading...

      // Start processing context for loading cached data
      processingContext.startProcessing();
      processingContext.setStage('beat-detection');
      processingContext.setProgress(50);
      processingContext.setStatusMessage('Loading cached analysis results...');

      // Convert cached data to AnalysisResult format
      const analysisResult: AnalysisResult = {
        chords: cachedData.chords || [],
        beats: cachedData.beats || [],
        downbeats: cachedData.downbeats || [],
        downbeats_with_measures: Array.isArray(cachedData.downbeats_with_measures)
          ? cachedData.downbeats_with_measures.map((item: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
              typeof item === 'number' ? item : item.time || 0
            )
          : [],
        synchronizedChords: cachedData.synchronizedChords || [],
        beatModel: cachedData.beatModel || 'beat-transformer',
        chordModel: cachedData.chordModel || 'chord-cnn-lstm',
        audioDuration: cachedData.audioDuration || 0,
        beatDetectionResult: {
          time_signature: (() => {
            const ts = cachedData.timeSignature as unknown;
            if (typeof ts === 'string') {
              return ts.includes('/') ? parseInt(ts.split('/')[0], 10) : parseInt(ts, 10);
            }
            return typeof ts === 'number' ? ts : undefined;
          })(),
          bpm: cachedData.bpm ?? undefined,
          beatShift: cachedData.beatShift ?? undefined
        }
      };

      // Update state to reflect cached analysis is loaded
      setAudioProcessingState(prev => ({
        ...prev,
        isAnalyzing: false,
        isAnalyzed: true,
        fromFirestoreCache: true
      }));

      // Set analysis results directly
      setAnalysisResults(analysisResult);

      // Update duration if available
      if (cachedData.audioDuration && cachedData.audioDuration > 0) {
        setDuration(cachedData.audioDuration);
        // console.log(`🎵 Updated duration from cached analysis: ${cachedData.audioDuration.toFixed(1)} seconds`);
      }

      // Complete processing context
      processingContext.completeProcessing();
      processingContext.setStage('complete');
      processingContext.setProgress(100);
      processingContext.setStatusMessage('Cached analysis loaded successfully');

      return analysisResult;
    } else {
      // console.log(`❌ No cached results found for ${currentBeatDetector} + ${currentChordDetector}, running new analysis...`);
    }
  } catch (cacheError) {
    console.warn('Cache check failed, proceeding with new analysis:', cacheError);
  }

  if (!audioProcessingState.audioUrl) {
    console.error('No audio URL available for analysis');
    return;
  }

  // No cached results found, proceed with new analysis
  // console.log('🔄 Starting new audio analysis...');

  let stageTimeout: NodeJS.Timeout | null = null;

  try {
    // Start processing context for new analysis
    processingContext.startProcessing();
    processingContext.setStage('chord-recognition');
    processingContext.setProgress(0);
    processingContext.setStatusMessage('Recognizing chords and synchronizing with beats...');

    // Update to beat detection stage after a brief delay
    stageTimeout = setTimeout(() => {
      processingContext.setStage('beat-detection');
      processingContext.setProgress(50);
      processingContext.setStatusMessage('Analyzing beat patterns and timing...');
    }, 1000);

    // Call the audio processing service with current model values
    const results = await analyzeAudioFromService(
      audioProcessingState.audioUrl,
      currentBeatDetector,
      currentChordDetector,
      {
        prefetchedTranscription: cachedData ?? null,
        onTranscriptionSaved: (transcriptionData) => {
          deps.setTranscriptionSnapshot?.(transcriptionData);
        },
        searchMetadata: {
          title: titleFromSearch,
          channelTitle: channelFromSearch,
          thumbnail: thumbnailFromSearch,
        },
      }
    );

    // Update duration from analysis results if available
    if (results.audioDuration && results.audioDuration > 0) {
      setDuration(results.audioDuration);
      // console.log(`🎵 Updated duration from analysis results: ${results.audioDuration.toFixed(1)} seconds`);
    }

    // FIXED: Clear the stage timeout to prevent it from overriding completion
    if (stageTimeout) {
      clearTimeout(stageTimeout);
      stageTimeout = null;
    }

    // Update processing context for completion
    processingContext.completeProcessing();

    return results;
  } catch (error) {
    console.error('Audio analysis failed:', error);

    // Clear timeout on error too
    if (stageTimeout) {
      clearTimeout(stageTimeout);
      stageTimeout = null;
    }

    // Update processing context for error
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    processingContext.failProcessing(errorMessage);

    throw error;
  }
};

/**
 * Transcribe lyrics using Music.AI with word-level synchronization
 * Lines 841-945 from original component
 */
export const transcribeLyricsWithAI = async (_deps: AudioProcessingServiceDependencies): Promise<void> => {
  // Lyrics transcription is disabled in the local-only build.
  //
  // FEATURE_SCOPE items 18-21 (lyric transcription / sync / translation /
  // Lead Sheet) were removed because they depend on external services
  // (Music.ai, Genius, LRClib, Gemini) that cannot run offline.
  //
  // The function is kept as a no-op stub so existing call sites and the
  // dependency-injection signature continue to compile. The UI no longer
  // exposes a lyrics tab, so this should never be invoked at runtime.
  console.warn(
    '[lyrics] Transcription is disabled in the local-only build; no external service was called.'
  );
};

/**
 * Extract audio from YouTube with comprehensive metadata preservation
 * Lines 947-1120 from original component
 */
export const extractAudioFromYouTube = async (
  _deps: AudioProcessingServiceDependencies,
  _forceRefresh: boolean = false
): Promise<{ audioUrl?: string; fromCache?: boolean; isStreamUrl?: boolean; streamExpiresAt?: number; title?: string; duration?: number } | void> => {
  // YouTube audio extraction is unavailable in the local-only build.
  //
  // FEATURE_SCOPE items 1-2 (YouTube search and URL-based extraction) were
  // dropped: they require the YouTube Data API plus yt-dlp, both of which are
  // online-only. Users analyse local audio files instead, which does not go
  // through this code path.
  throw new Error(
    'YouTube audio extraction is not available in the local-only build. Upload a local audio file instead.'
  );
};
