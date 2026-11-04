"use client";

import { useState, useRef, useEffect, useMemo, useCallback, type ComponentProps } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@heroui/react';
import { addToast } from '@heroui/react';
import { mergeToastClassNames } from '@/utils/toastStyles';
import Navigation from '@/components/common/Navigation';
import { analyzeAudioWithRateLimit, AnalysisResult } from '@/services/chord-analysis/chordRecognitionService';
import { ProcessingStatusSkeleton } from '@/components/common/SkeletonLoaders';
import {
  getChordGridData as getChordGridDataService
} from '@/services/chord-analysis/chordGridCalculationService';

// Dynamic imports for heavy components with better loading states
const HeroUIBeatModelSelector = dynamic(() => import('@/components/analysis/HeroUIBeatModelSelector'), {
  loading: () => (
    <div className="space-y-2">
      <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      <div className="h-12 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />
    </div>
  ),
  ssr: false
});

const HeroUIChordModelSelector = dynamic(() => import('@/components/analysis/HeroUIChordModelSelector'), {
  loading: () => (
    <div className="space-y-2">
      <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      <div className="h-12 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />
    </div>
  ),
  ssr: false
});


const ProcessingStatusBanner = dynamic(() => import('@/components/analysis/ProcessingStatusBanner'), {
  loading: () => <ProcessingStatusSkeleton />,
  ssr: true
});

// Chatbot interface removed: required Gemini, unavailable in the local-only
// build (FEATURE_SCOPE item 17).





const ChordGridContainer = dynamic(() => import('@/components/chord-analysis/ChordGridContainer').then(mod => ({ default: mod.ChordGridContainer })), {
  loading: () => <div className="h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

const GuitarChordsTab = dynamic(() => import('@/components/chord-analysis/GuitarChordsTab'), {
  loading: () => <div className="h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

const PianoVisualizerTab = dynamic(() => import('@/components/piano-visualizer/PianoVisualizerTab'), {
  loading: () => <div className="h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

// Floating song-lyrics panel, restored from upstream. Same layout as the
// original; it only displays the lyrics loaded from local sources.
const LyricsSection = dynamic(() => import('@/components/lyrics/LyricsSection').then(mod => ({ default: mod.LyricsSection })), {
  loading: () => <div className="h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

const LyricsPanel = dynamic(() => import('@/components/lyrics/LyricsPanel'), {
  ssr: false
});

import { useProcessing } from '@/contexts/ProcessingContext';
import BeatTimeline from '@/components/analysis/BeatTimeline';
import KeySignatureSync from '@/components/analysis/KeySignatureSync';
import LocalCachePanel from '@/components/analysis/LocalCachePanel';
import { simplifyChordArray } from '@/utils/chordSimplification';
import { useUIStore, useIsLoopEnabled, useLoopStartBeat, useLoopEndBeat, useIsPitchShiftEnabled, useIsPitchShiftReady } from '@/stores/uiStore';

import { useMetronomeSync } from '@/hooks/chord-playback/useMetronomeSync';
import { useMelodicTranscriptionPlayback } from '@/hooks/chord-playback/useMelodicTranscriptionPlayback';
import { metronomeService } from '@/services/chord-playback/metronomeService';
import { resolveLoopRange } from '@/hooks/chord-playback/useLoopPlayback';
import { useLyricsState } from '@/hooks/lyrics/useLyricsState';
import { useSegmentationState } from '@/hooks/lyrics/useSegmentationState';
import { useAnalysisStore } from '@/stores/analysisStore';
import UtilityBar from '@/components/analysis/UtilityBar';
import ScrollableTabContainer from '@/components/chord-analysis/ScrollableTabContainer';
import AudioPlaybackDock from '@/components/analysis/AudioPlaybackDock';
import type { UseChordPlaybackReturn } from '@/hooks/chord-playback/useChordPlayback';
import { estimateKeySignatureFromChords } from '@/utils/chordUtils';
import type { KeyDetectionResult } from '@/services/audio/keyDetectionService';
import { DEFAULT_PIANO_VOLUME, DEFAULT_GUITAR_VOLUME, DEFAULT_VIOLIN_VOLUME, DEFAULT_FLUTE_VOLUME } from '@/config/audioDefaults';
import { ChordPlaybackManager } from '@/components/chord-playback/ChordPlaybackManager';
import { usePlaybackStore, useCurrentBeatIndex } from '@/stores/playbackStore';
import { usePitchShiftAudio } from '@/hooks/chord-playback/usePitchShiftAudio';
import ResultsTabs from '@/components/homepage/ResultsTabs';
import type { TabKey } from '@/components/homepage/ResultsTabs';
import type { LyricsData } from '@/types/musicAiTypes';
import { parseLyricsFile, resolveLocalLyrics } from '@/utils/lyrics/localLyrics';
import {
  extractLyricsFromAudioUrl,
  loadLyricsForAudio,
  saveLyricsForAudio,
} from '@/utils/lyrics/lyricsCache';
import { toGridTimedLyrics } from '@/utils/lyrics/gridLyrics';
import { requestSheetSageTranscription } from '@/services/sheetsage/sheetSageTranscriptionClient';
import { useSheetSageBackendAvailability } from '@/hooks/sheetsage/useSheetSageBackendAvailability';
import { getSafeBeatModel, getSafeChordModel } from '@/utils/modelFiltering';
import { MAX_ANALYSIS_DURATION_MINUTES, getAnalysisDurationLimitReason } from '@/utils/analysisDurationLimit';
import { buildAnalysisResultFromCache } from '@/services/cache/restoredAnalysis';
import MelodyTranscriptionStatusToast from '@/components/analysis/MelodyTranscriptionStatusToast';
import type { PromptExportInput } from '@/utils/promptExport';

export default function LocalAudioAnalyzePage() {
  // Sheet Sage melody transcription is kept for parity with the upstream
  // project (FEATURE_SCOPE item 24). The local Sheet Sage service (expected at
  // http://localhost:8082) is not configured on this machine, so the backend
  // probe reports unavailable and the dock toggle renders disabled with the
  // reason it returns. Enabling it needs no code change 鈥?only the service.
  const showSheetSage = true;
  useSheetSageBackendAvailability(showSheetSage);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const durationLimitToastShownRef = useRef(false);

  const {
    lyrics,
    showLyrics,
    hasCachedLyrics,
    completeLyricsTranscription,
    setLyrics,
    setShowLyrics,
    setHasCachedLyrics,
  } = useLyricsState();
  // Local lyric sources (fully offline): an optional lyric file the user picks,
  // plus lyric tags embedded in the audio file itself.
  const [lyricsFile, setLyricsFile] = useState<File | null>(null);
  // Shown in the pickers: after reopening a cached analysis there is no File
  // object any more, only the name the backend recorded for that audio.
  const [restoredAudioName, setRestoredAudioName] = useState<string | null>(null);
  const [lyricsSourceName, setLyricsSourceName] = useState<string | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const lyricsFileInputRef = useRef<HTMLInputElement | null>(null);
  // Local lyrics are laid into the chord grid rows automatically (no toggle):
  // same data the Lyrics & Chords tab renders, just fed to the grid too.
  const gridTimedLyrics = useMemo(() => toGridTimedLyrics(lyrics), [lyrics]);
  const analysisDurationLimitReason = useMemo(
    () => getAnalysisDurationLimitReason(duration),
    [duration],
  );

  useEffect(() => {
    if (analysisDurationLimitReason && !durationLimitToastShownRef.current) {
      durationLimitToastShownRef.current = true;
      addToast({
        title: 'Audio is too long for analysis',
        description: `Audio duration should be less than ${MAX_ANALYSIS_DURATION_MINUTES} minutes.`,
        color: 'default',
        timeout: 5000,
        shouldShowTimeoutProgress: true,
        classNames: mergeToastClassNames({
          icon: 'text-warning-500',
          title: 'text-warning-600 dark:text-warning-400',
        }),
      });
      return;
    }

    if (!analysisDurationLimitReason) {
      durationLimitToastShownRef.current = false;
    }
  }, [analysisDurationLimitReason]);
  const {
    segmentationData,
    showSegmentation,
    isSegmenting,
    segmentationError,
    toggleSegmentation,
    resetSegmentation,
  } = useSegmentationState();

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
        objectUrlRef.current = null;
      }
    };
  }, []);

  // Use processing context
  const {
    // stage,
    // progress,
    setStage,
    setProgress,
    setStatusMessage,
    startProcessing,
    completeProcessing,
    failProcessing
  } = useProcessing();
  // const { theme } = useTheme();

  // Define detector types
  type BeatDetectorType = 'madmom' | 'beat-transformer';
  type ChordDetectorType = 'chord-cnn-lstm' | 'btc-sl' | 'btc-pl';

  // Initialize model states with localStorage persistence
  const [beatDetector, setBeatDetector] = useState<BeatDetectorType>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('chordmini_beat_detector');
      if (saved && ['madmom', 'beat-transformer'].includes(saved)) {
        return getSafeBeatModel(saved as BeatDetectorType);
      }
      // If saved value was 'auto', default to 'madmom'
      if (saved === 'auto') {
        localStorage.setItem('chordmini_beat_detector', 'madmom');
      }
    }
    return 'madmom';
  });

  const [chordDetector, setChordDetector] = useState<ChordDetectorType>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('chordmini_chord_detector');
      if (saved && ['chord-cnn-lstm', 'btc-sl', 'btc-pl'].includes(saved)) {
        return getSafeChordModel(saved as ChordDetectorType);
      }
    }
    return 'chord-cnn-lstm';
  });

  // Audio processing state
  const [audioProcessingState, setAudioProcessingState] = useState({
    isExtracting: false,
    isExtracted: false,
    isAnalyzing: false,
    isAnalyzed: false,
    error: null as string | null,
    audioBuffer: null as AudioBuffer | null,
    audioUrl: null as string | null,
  });
  // Analysis results state (must be declared before dependent memos)
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult | null>(null);

  // Lyrics state (before memos that depend on it)
  const [fontSize, setFontSize] = useState<number>(16);
  const theme = 'light';

  // Stable upload session id for chatbot context
  const uploadSessionId = useMemo(() => `upload_${Date.now().toString(36)}`, []);

  // Build SongContext for Chatbot (upload source)
  const uploadSongContext = useMemo(() => {
    if (!analysisResults) return undefined;
    return {
      uploadId: uploadSessionId,
      title: audioFile?.name || 'Uploaded Audio',
      duration,
      beats: analysisResults?.beats,
      downbeats: analysisResults?.downbeats,
      downbeats_with_measures: analysisResults?.downbeats_with_measures,
      beats_with_positions: analysisResults?.beats_with_positions,
      bpm: analysisResults?.beatDetectionResult?.bpm,
      time_signature: analysisResults?.beatDetectionResult?.time_signature,
      beatModel: analysisResults?.beatModel || beatDetector,
      chords: analysisResults?.chords,
      synchronizedChords: analysisResults?.synchronizedChords,
      chordModel: analysisResults?.chordModel || chordDetector,
      lyrics: lyrics || undefined,
      audioUrl: audioProcessingState.audioUrl || undefined,
    } as const;
  }, [analysisResults, uploadSessionId, audioFile?.name, duration, lyrics, beatDetector, chordDetector, audioProcessingState.audioUrl]);

  useEffect(() => {
    resetSegmentation();
  }, [analysisResults, resetSegmentation]);

  const segmentationDisabledReason = !uploadSongContext?.audioUrl
    ? 'Song segmentation becomes available after audio extraction finishes.'
    : uploadSongContext.audioUrl.startsWith('blob:')
      ? 'Song segmentation requires a backend-accessible extracted audio URL.'
      : !uploadSongContext.beats?.length
        ? 'Song segmentation becomes available after beat analysis finishes.'
        : undefined;

  const canAnalyzeSegmentation = !segmentationDisabledReason;

  const handleSegmentationToggle = useCallback(() => {
    void toggleSegmentation(uploadSongContext);
  }, [toggleSegmentation, uploadSongContext]);



  // Chord playback state (will be managed by ChordPlaybackManager)
  const [chordPlayback, setChordPlayback] = useState<UseChordPlaybackReturn>({
    isEnabled: false,
    pianoVolume: DEFAULT_PIANO_VOLUME,
    guitarVolume: DEFAULT_GUITAR_VOLUME,
    violinVolume: DEFAULT_VIOLIN_VOLUME,
    fluteVolume: DEFAULT_FLUTE_VOLUME,
    isReady: false,
    togglePlayback: () => {},
    setPianoVolume: () => {},
    setGuitarVolume: () => {},
    setViolinVolume: () => {},
    setFluteVolume: () => {}
  });

  const handleChordPlaybackChange = useCallback((next: UseChordPlaybackReturn) => {
    setChordPlayback(next);
  }, []);

  // Panels and countdown
  const [isLyricsPanelOpen, setIsLyricsPanelOpen] = useState<boolean>(false);
  const toggleLyricsPanel = () => setIsLyricsPanelOpen(prev => !prev);
  const [isChatbotOpen, setIsChatbotOpen] = useState<boolean>(false);
  const [isCountdownEnabled, setIsCountdownEnabled] = useState<boolean>(false);
  const [isCountingDown, setIsCountingDown] = useState<boolean>(false);
  const [countdownDisplay, setCountdownDisplay] = useState<string>('');

  // Tempo context
  const timeSignature = analysisResults?.beatDetectionResult?.time_signature || 4;
  const bpm = analysisResults?.beatDetectionResult?.bpm || 120;

  // Countdown controller state (HTML audio)
  const countdownCtrlRef = useRef<{ intervalId: ReturnType<typeof setInterval> | null; aborted: boolean; token: number } | null>(null);
  const countdownStateRef = useRef<{ inProgress: boolean; completed: boolean }>({ inProgress: false, completed: false });

  const cancelCountdown = useCallback(() => {
    const ctrl = countdownCtrlRef.current;
    if (ctrl) {
      ctrl.aborted = true;
      if (ctrl.intervalId) clearInterval(ctrl.intervalId as unknown as number);
      countdownCtrlRef.current = null;
    }
    countdownStateRef.current.inProgress = false;
    setIsCountingDown(false);
    setCountdownDisplay('');
  }, []);

  const runCountdown = useCallback(async () => {
    if (!isCountdownEnabled) return true;
    if (countdownStateRef.current.inProgress) return false;

    const beatsPerMeasure = Math.max(2, Math.min(12, timeSignature || 4));
    const beatDurationSec = 60 / Math.max(1, bpm || 120);
    const totalMs = beatsPerMeasure * beatDurationSec * 1000;

    const start = Date.now();
    const token = Math.random();
    const ctrl = { intervalId: null as ReturnType<typeof setInterval> | null, aborted: false, token };
    countdownCtrlRef.current = ctrl;

    // Prepare state and ensure audio paused
    countdownStateRef.current.inProgress = true;
    countdownStateRef.current.completed = false;
    try { audioRef.current?.pause(); } catch {}
    setIsCountingDown(true);
    setCountdownDisplay(`${beatsPerMeasure}`);

    const ok = await new Promise<boolean>((resolve) => {
      ctrl.intervalId = setInterval(() => {
        if (!countdownCtrlRef.current || countdownCtrlRef.current.token !== token || countdownCtrlRef.current.aborted) {
          if (ctrl.intervalId) clearInterval(ctrl.intervalId as unknown as number);
          countdownStateRef.current.inProgress = false;
          setIsCountingDown(false);
          setCountdownDisplay('');
          resolve(false);
          return;
        }
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, totalMs - elapsed);
        const remainingBeats = Math.ceil(remaining / (beatDurationSec * 1000));
        setCountdownDisplay(`${remainingBeats}`);
        if (remaining <= 0) {
          if (ctrl.intervalId) clearInterval(ctrl.intervalId as unknown as number);
          countdownCtrlRef.current = null;
          countdownStateRef.current.inProgress = false;
          countdownStateRef.current.completed = true;
          setIsCountingDown(false);
          setCountdownDisplay('');
          resolve(true);
        }
      }, 100);
    });

    return ok;
  }, [isCountdownEnabled, timeSignature, bpm]);


  // Metronome state
  const [isMetronomeEnabled, setIsMetronomeEnabled] = useState<boolean>(false);

  const disableMetronomeService = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    void metronomeService.setEnabled(false);
  }, []);

  const toggleFollowMode = () => setIsFollowModeEnabled(prev => !prev);
  const toggleChatbot = () => setIsChatbotOpen(prev => !prev);


  // Current state for playback
  // SSoT: currentBeatIndex is owned by playbackStore. We subscribe here so the
  // component re-renders when the animation loop publishes a new beat, and we
  // keep a ref for synchronous reads inside the rAF callback below.
  const currentBeatIndex = useCurrentBeatIndex();
  const setCurrentBeatIndex = useCallback((index: number) => {
    usePlaybackStore.getState().setCurrentBeatIndex(index);
  }, []);
  const currentBeatIndexRef = useRef(-1);
  const lastScrollTimeRef = useRef(0);

  const [isFollowModeEnabled, setIsFollowModeEnabled] = useState(true);

  // Tab state
  const [activeTab, setActiveTab] = useState<TabKey>('beatChordMap');
  const sheetSageResult = useAnalysisStore((state) => state.sheetSageResult);
  const isComputingSheetSage = useAnalysisStore((state) => state.isComputingSheetSage);
  const sheetSageError = useAnalysisStore((state) => state.sheetSageError);
  const isCheckingSheetSageBackend = useAnalysisStore((state) => state.isCheckingSheetSageBackend);
  const isSheetSageBackendAvailable = useAnalysisStore((state) => state.isSheetSageBackendAvailable);
  const sheetSageBackendError = useAnalysisStore((state) => state.sheetSageBackendError);
  const isMelodicTranscriptionPlaybackEnabled = useUIStore((state) => state.isMelodicTranscriptionPlaybackEnabled);
  const setIsMelodicTranscriptionPlaybackEnabled = useUIStore((state) => state.setIsMelodicTranscriptionPlaybackEnabled);


  // Key signature and chord correction states - now with proper key detection
  const [keySignature, setKeySignature] = useState<string | null>(null);
  const [isDetectingKey, setIsDetectingKey] = useState(false);
  const [keyDetectionAttempted, setKeyDetectionAttempted] = useState(false);
  const showCorrectedChords = false;
  const chordCorrections = useMemo(() => ({} as Record<string, string>), []);
  const [sequenceCorrections, setSequenceCorrections] = useState<
    KeyDetectionResult['sequenceCorrections'] | null
  >(null);
  // Item 27 (AI prompt export) needs the Roman numerals and key confidence.
  // Roman numerals normally live in the zustand store, but the store can be
  // overwritten by other pages, so keep a page-local copy here.
  const [romanNumerals, setRomanNumerals] = useState<KeyDetectionResult['romanNumerals']>(null);
  const [keyConfidence, setKeyConfidence] = useState<number | null>(null);
  const [keyModulations, setKeyModulations] = useState<KeyDetectionResult['modulations']>([]);

  // Get state from Zustand stores (only what's actually used in this page)

  // Track transient stage timeout for analysis status so we can clean it up on unmount
  const stageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Note: simplifyChords, showRomanNumerals, showSegmentation are managed by Zustand
  // and accessed directly by child components via their own selectors
  const hasSheetSageNotes = (sheetSageResult?.noteEvents?.length ?? 0) > 0;
  const hasSheetSageAudioSource = Boolean(audioFile || audioProcessingState.audioUrl);
  const hasReadySheetSageBackend = isSheetSageBackendAvailable === true;
  const needsSheetSageBackendForCompute = !hasSheetSageNotes;
  const melodicTranscriptionDisabledReason = isCheckingSheetSageBackend
    ? (needsSheetSageBackendForCompute ? 'Checking Sheet Sage backend...' : undefined)
    : needsSheetSageBackendForCompute && !hasReadySheetSageBackend
      ? (sheetSageBackendError || 'Sheet Sage backend unavailable.')
    : !hasSheetSageAudioSource
    ? 'Load audio before computing melodic transcription.'
    : undefined;

  const toggleMelodicTranscriptionPlayback = useCallback(async () => {
    if (!hasSheetSageAudioSource || isComputingSheetSage) {
      return;
    }

    const analysisActions = useAnalysisStore.getState();

    if (isMelodicTranscriptionPlaybackEnabled) {
      setIsMelodicTranscriptionPlaybackEnabled(false);
      return;
    }

    if (!hasSheetSageNotes) {
      if (!hasReadySheetSageBackend) {
        analysisActions.setSheetSageError(sheetSageBackendError || 'Sheet Sage backend unavailable.');
        return;
      }

      analysisActions.setIsComputingSheetSage(true);
      analysisActions.setSheetSageError(null);

      try {
        const result = await requestSheetSageTranscription(audioFile, audioProcessingState.audioUrl || null);
        analysisActions.setSheetSageResult(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown Sheet Sage error';
        analysisActions.setSheetSageError(message);
        analysisActions.setIsComputingSheetSage(false);
        return;
      } finally {
        analysisActions.setIsComputingSheetSage(false);
      }
    }

    setActiveTab('pianoVisualizer');
    setIsMelodicTranscriptionPlaybackEnabled(true);
  }, [
    audioFile,
    audioProcessingState.audioUrl,
    hasSheetSageAudioSource,
    hasReadySheetSageBackend,
    hasSheetSageNotes,
    isComputingSheetSage,
    isMelodicTranscriptionPlaybackEnabled,
    setActiveTab,
    setIsMelodicTranscriptionPlaybackEnabled,
    sheetSageBackendError,
  ]);

  // Use pitch shift audio hook
  usePitchShiftAudio({
    youtubePlayer: null, // No YouTube player in upload page
    audioRef,
    localAudioUrl: audioProcessingState.audioUrl,
    isPlaying,
    currentTime,
    playbackRate,
    setIsPlaying,
    setCurrentTime,
  });

  useMelodicTranscriptionPlayback({
    sheetSageResult,
    audioUrl: audioProcessingState.audioUrl || null,
    segmentationData,
    audioRef,
    currentTime,
    isPlaying,
    isEnabled: isMelodicTranscriptionPlaybackEnabled,
  });

  // Persist model preferences to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chordmini_beat_detector', beatDetector);
    }
  }, [beatDetector]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chordmini_chord_detector', chordDetector);
    }
  }, [chordDetector]);

  // Handle file upload
  const handleLyricsFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    setLyricsFile(file);
    setLyricsSourceName(file.name);

    try {
      // Prefer the audio's embedded tags when a lyric file is also present?
      // No: an explicitly picked lyric file always wins.
      const resolved = audioFile ? await resolveLocalLyrics(audioFile, file) : null;
      const data = resolved ? resolved.data : await parseLyricsFile(file);
      completeLyricsTranscription(data);
      addToast({
        title: 'Lyrics loaded',
        description: `From ${file.name}`,
        color: 'success',
      });
    } catch (error) {
      addToast({
        title: 'Could not read that lyric file',
        description: error instanceof Error ? error.message : 'Unsupported lyric file format.',
        color: 'danger',
      });
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    setAudioFile(file);
    setRestoredAudioName(null);

    // Local lyrics: surface lyric tags embedded in the uploaded audio file
    // (and/or the lyric file already picked). No network involved.
    void resolveLocalLyrics(file, lyricsFile)
      .then((result) => {
        if (result) {
          completeLyricsTranscription(result.data);
          setLyricsSourceName(
            result.source === 'lyrics-file'
              ? (lyricsFile?.name ?? null)
              : `${file.name} (embedded tags)`,
          );
          addToast({
            title: 'Lyrics loaded',
            description: result.source === 'lyrics-file'
              ? 'From the lyric file you picked.'
              : "Read from the audio file's embedded lyric tags.",
            color: 'success',
          });
        } else if (!lyricsFile) {
          setLyrics(null);
          setShowLyrics(false);
        }
      })
      .catch(() => {
        // Unreadable/absent tags: stay quiet, the lyrics tab explains the local sources.
      });

    // Reset states
    setAudioProcessingState({
      isExtracting: false,
      isExtracted: false,
      isAnalyzing: false,
      isAnalyzed: false,
      error: null,
      audioBuffer: null,
      audioUrl: null,
    });
    setAnalysisResults(null);
    setKeyDetectionAttempted(false);
    setSequenceCorrections(null);

    // Create a blob URL for the audio element (Safari-safe) and track it for cleanup
    if (audioRef.current) {
      if (objectUrlRef.current) {
        try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
        objectUrlRef.current = null;
      }
      const u = URL.createObjectURL(file);
      objectUrlRef.current = u;
      audioRef.current.src = u;
      audioRef.current.load();
    }
  };

  /**
   * Reopens an analysis from the local cache ("open last analysis").
   *
   * No model is re-run: the backend `/api/cache/restore` returns the cached
   * chords / beats, which are converted into an `AnalysisResult` here while the
   * audio points at the same-origin `/api/audio/<id>`, so a page refresh or a
   * reopen shows the previous grid immediately.
   */
  const openCachedAnalysis = useCallback(async (audioId: string) => {
    setAudioProcessingState(prev => ({
      ...prev,
      error: null,
      isExtracting: false,
      isAnalyzing: false,
      isAnalyzed: false,
    }));

    const response = await fetch(
      `/api/local-cache/restore?audioId=${encodeURIComponent(audioId)}`,
      { cache: 'no-store' },
    );

    if (!response.ok) {
      const message = response.status === 404
        ? 'The cached data for this audio is incomplete. Please analyze it again.'
        : 'Could not open the cached analysis.';
      addToast({
        title: 'Cached Results Unavailable',
        description: message,
        color: 'default',
        timeout: 5000,
        shouldShowTimeoutProgress: true,
        classNames: mergeToastClassNames({
          icon: 'text-warning-500',
          title: 'text-warning-600 dark:text-warning-400',
        }),
      });
      return;
    }

    const restored = await response.json();
    const rebuilt = buildAnalysisResultFromCache(restored);

    if (!rebuilt) {
      addToast({
        title: 'Cached Results Incomplete',
        description: 'The cache is missing chord or beat data. Please analyze it again.',
        color: 'default',
        timeout: 5000,
        shouldShowTimeoutProgress: true,
        classNames: mergeToastClassNames({
          icon: 'text-warning-500',
          title: 'text-warning-600 dark:text-warning-400',
        }),
      });
      return;
    }

    // Audio goes through the same-origin proxy route, so the browser never needs the backend port
    if (audioRef.current) {
      audioRef.current.src = restored.audioUrl;
      audioRef.current.load();
    }

    setAnalysisResults(rebuilt);
    setKeyDetectionAttempted(false);
    setSequenceCorrections(null);
    setRomanNumerals(null);
    setKeyConfidence(null);
    setKeyModulations([]);
    setAudioFile(null);
    setRestoredAudioName(restored.filename || null);
    if (typeof restored.duration === 'number' && restored.duration > 0) {
      setDuration(restored.duration);
    }
    setAudioProcessingState(prev => ({
      ...prev,
      audioUrl: restored.audioUrl,
      isExtracted: true,
      isExtracting: false,
      isAnalyzing: false,
      isAnalyzed: true,
      error: null,
    }));
    setStage('complete');
    setProgress(100);
    setStatusMessage('Loaded from local cache');

    // Cached rows only carry chords and beats: bring the local lyrics back from
    // the kv store, or re-read the tags embedded in the stored audio.
    try {
      const cachedLyrics = await loadLyricsForAudio(audioId);
      if (cachedLyrics) {
        completeLyricsTranscription(cachedLyrics.data);
        setHasCachedLyrics(true);
        setLyricsSourceName(cachedLyrics.name);
      } else {
        const extractedLyrics = await extractLyricsFromAudioUrl(
          restored.audioUrl,
          restored.filename,
        );
        if (extractedLyrics) {
          const label = restored.filename ? `${restored.filename} (embedded tags)` : null;
          completeLyricsTranscription(extractedLyrics);
          setHasCachedLyrics(true);
          setLyricsSourceName(label);
          void saveLyricsForAudio(audioId, extractedLyrics, label);
        } else {
          setLyrics(null);
          setShowLyrics(false);
          setHasCachedLyrics(false);
          setLyricsSourceName(null);
        }
      }
    } catch {
      // Lyrics are optional here: never block a restored analysis over them.
    }
    // Same copy and styling as the original project's "Analysis Complete" toast (ProcessingStatusBanner:190)
    addToast({
      title: 'Analysis Complete',
      description: `Beat and chord analysis completed in 00:00.00 路 Results Cache${
        restored.filename ? ` 路 ${restored.filename}` : ''
      }`,
      color: 'default',
      timeout: 5000,
      shouldShowTimeoutProgress: true,
      classNames: mergeToastClassNames({
        icon: 'text-success-500',
        title: 'text-success-600 dark:text-success-400',
      }),
    });
  }, [completeLyricsTranscription, setLyrics, setShowLyrics, setHasCachedLyrics, setLyricsSourceName]);

  // Process and analyze the audio file
  const processAudioFile = async () => {
    if (!audioFile) return;
    if (analysisDurationLimitReason) {
      setAudioProcessingState(prev => ({
        ...prev,
        error: analysisDurationLimitReason,
        isExtracting: false,
        isAnalyzing: false,
      }));
      return;
    }

    stageTimeoutRef.current = null;

    try {
      setKeyDetectionAttempted(false);
      setSequenceCorrections(null);

      // Start processing context
      startProcessing();
      setStage('chord-recognition');
      setProgress(0);
      setStatusMessage('Recognizing chords and synchronizing with beats...');

      // Use existing object URL from audio element or create new one (track and cleanup)
      let audioUrl = audioRef.current?.src;
      if (!audioUrl) {
        if (objectUrlRef.current) {
          try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
          objectUrlRef.current = null;
        }
        const u = URL.createObjectURL(audioFile);
        objectUrlRef.current = u;
        audioUrl = u;
      }

      setAudioProcessingState(prev => ({
        ...prev,
        isExtracting: true,
        error: null,
        audioUrl,
      }));

      // Get duration from audio element for progress calculation
      if (audioRef.current && audioRef.current.duration && duration === 0) {
        setDuration(audioRef.current.duration);
      }

      // Update to beat detection stage after duration is available
      stageTimeoutRef.current = setTimeout(() => {
        setStage('beat-detection');
        // Don't set progress here - let ProcessingStatusBanner calculate it
        setStatusMessage('Analyzing beat patterns and timing...');
      }, 500); // Reduced delay since we now have duration

      setAudioProcessingState(prev => ({
        ...prev,
        isExtracted: true,
        isExtracting: false,
        audioBuffer: null, // No longer using AudioBuffer
        isAnalyzing: true
      }));

      // Start chord and beat analysis with selected detectors using original File object
      // This avoids the 10x size bloat from AudioBuffer conversion (3.6MB 鈫?41.7MB)
      const results = await analyzeAudioWithRateLimit(audioFile, beatDetector, chordDetector);

      // FIXED: Clear the stage timeout to prevent it from overriding completion
      if (stageTimeoutRef.current) {
        clearTimeout(stageTimeoutRef.current);
        stageTimeoutRef.current = null;
      }

      // Store results
      setAnalysisResults(results);

      // Update duration from analysis results if available
      if (results.audioDuration && results.audioDuration > 0) {
        setDuration(results.audioDuration);
      }

      setAudioProcessingState(prev => ({
        ...prev,
        isExtracting: false,
        isAnalyzing: false,
        isAnalyzed: true
      }));

      // Complete processing
      setStage('complete');
      setProgress(100);
      setStatusMessage('Analysis complete!');
      completeProcessing();

      // Analysis completed successfully
    } catch (error) {
      console.error('Error in audio processing:', error);

      // Clear timeout on error
      if (stageTimeoutRef.current) {
        clearTimeout(stageTimeoutRef.current);
        stageTimeoutRef.current = null;
      }

      // Format error message more user-friendly
      let errorMessage = 'Unknown error occurred';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      setAudioProcessingState(prev => ({
        ...prev,
        error: errorMessage,
        isExtracting: false,
        isAnalyzing: false
      }));

      // Fail processing
      failProcessing(errorMessage);
    }
  };

  // Audio player controls
  const playPause = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      // Gate first play with optional 1-measure countdown
      if (isCountdownEnabled && !countdownStateRef.current.inProgress && !countdownStateRef.current.completed) {
        try { audioRef.current.pause(); } catch {}
        // Run countdown asynchronously, then start playback if not aborted
        void (async () => {
          const ok = await runCountdown();
          if (ok) {
            countdownStateRef.current.completed = false; // consume
            try { await audioRef.current?.play(); } catch {}
          }
        })();
        return;
      }
      audioRef.current.play();
    }
  };

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    // Fan out through the store so the pitch shift service and HTMLAudioElement
    // stay aligned with the slider even when the local <audio> ref is not yet
    // attached.
    try {
      usePlaybackStore.getState().setPlayerPlaybackRate(rate);
    } catch (error) {
      console.warn('setPlayerPlaybackRate fan-out failed:', error);
    }
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };


  // Set up audio element event listeners
  // Pitch-shift gating: used by the audio-element `timeupdate` listener
  // below to honour the "GrainPlayer is the sole writer of currentTime"
  // invariant. Declared here so the useEffect below captures a stable
  // selector subscription (Zustand re-renders when either flag flips).
  const isPitchShiftEnabledForGuard = useIsPitchShiftEnabled();
  const isPitchShiftReadyForGuard = useIsPitchShiftReady();
  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) return;

    const handleLoadedMetadata = () => {
      if (audioElement) {
        setDuration(audioElement.duration);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
    };
    const handlePause = () => {
      setIsPlaying(false);
    };
    const handleTimeUpdate = () => {
      if (!audioElement) return;
      // CLOCK AUTHORITY GUARD: see matching comment in usePlaybackState.ts.
      // During pitch-shift mode, GrainPlayer is the sole writer of
      // `currentTime`. The muted <audio> element keeps running its own
      // native clock and must NOT race the GrainPlayer tick here.
      if (isPitchShiftEnabledForGuard && isPitchShiftReadyForGuard) return;
      setCurrentTime(audioElement.currentTime);
    };

    audioElement.addEventListener('loadedmetadata', handleLoadedMetadata);

    audioElement.addEventListener('play', handlePlay);
    audioElement.addEventListener('pause', handlePause);
    audioElement.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      if (audioElement) {
        audioElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
        audioElement.removeEventListener('play', handlePlay);
        audioElement.removeEventListener('pause', handlePause);
        audioElement.removeEventListener('timeupdate', handleTimeUpdate);
      }
    };
  }, [isPitchShiftEnabledForGuard, isPitchShiftReadyForGuard]);

  // Use standardized chord grid data processing from service
  // This ensures perfect consistency with the YouTube workflow
  const chordGridData = useMemo(() => {
    if (!analysisResults) {
      return {
        chords: [],
        beats: [],
        hasPadding: false,


        paddingCount: 0,
        shiftCount: 0,
        totalPaddingCount: 0,
        originalAudioMapping: []

      };
    }
    return getChordGridDataService(analysisResults);
  }, [analysisResults]);

  // Key detection effect - automatically detect key after chord analysis
  useEffect(() => {
    if (analysisResults?.chords && analysisResults.chords.length > 0 && !isDetectingKey && !keyDetectionAttempted) {
      setIsDetectingKey(true);
      setKeyDetectionAttempted(true);

      // Prepare chord data for key detection


      // CRITICAL FIX: Deduplicate consecutive identical chords to avoid beat-level analysis
      const rawChordData = analysisResults.chords


        .filter((chord) => chord.time !== undefined && chord.time !== null)
        .map((chord) => ({
          chord: chord.chord,
          time: chord.time as number // Safe to cast since we filtered out undefined/null
        }));

      // Remove consecutive duplicate chords to get only chord changes
      const chordData = rawChordData.filter((chord, index) => {
        if (index === 0) return true; // Always include first chord
        return chord.chord !== rawChordData[index - 1].chord; // Include only if different from previous
      });
      const heuristicKeySignature = estimateKeySignatureFromChords(chordData.map((entry) => entry.chord)).keySignature;

      setKeySignature(heuristicKeySignature);



      // Import and call key detection service with enharmonic correction and Roman numerals
      import('@/services/audio/keyDetectionService').then(({ detectKey }) => {
        // Use cache for sequence corrections (no bypass); request Roman numerals.
        // The 5th argument is the content-addressed id in the local audio store:
        // the backend uses it to run its madmom key CNN on the audio itself for
        // key and section detection (far more robust than reading chord symbols).
        detectKey(chordData, true, false, true, analysisResults.audioId)
          .then(result => {
            setKeySignature(
              result.primaryKey && result.primaryKey !== 'Unknown'
                ? result.primaryKey
                : heuristicKeySignature
            );
            setSequenceCorrections(result.sequenceCorrections ?? null);
            setRomanNumerals(result.romanNumerals ?? null);
            setKeyConfidence(
              typeof result.keyConfidence === 'number' && Number.isFinite(result.keyConfidence)
                ? result.keyConfidence
                : null
            );
            setKeyModulations(result.modulations ?? []);
            // Update Roman numeral data in UI store for display
            try {
              useUIStore.getState().updateRomanNumeralData(result.romanNumerals ?? null);
            } catch {}
          })
          .catch(error => {
            console.error('Failed to detect key:', error);
            setSequenceCorrections(null);
            setRomanNumerals(null);
            setKeyConfidence(null);
            setKeyModulations([]);
            try { useUIStore.getState().updateRomanNumeralData(null); } catch {}
          })
          .finally(() => {
            setIsDetectingKey(false);
          });
      });
    }
  }, [analysisResults?.chords, isDetectingKey, keyDetectionAttempted]);

// Apply optional chord simplification (UI toggle)
const simplifyChords = useUIStore((state) => state.simplifyChords);
const simplifiedChordGridData = useMemo(() => {
  if (!chordGridData) return chordGridData;
  let processedChords = chordGridData.chords || [];
  if (simplifyChords) {
    processedChords = simplifyChordArray(processedChords);
  }
  return { ...chordGridData, chords: processedChords } as typeof chordGridData;
}, [chordGridData, simplifyChords]);

  /**
   * Input for item 27 (AI prompt export).
   *
   * The chord array is the UNSIMPLIFIED `chordGridData.chords`, i.e. the same
   * one feeding the Roman numeral mapping (`originalChordsForRomanNumerals`);
   * the simplify toggle only affects display.
   * Beat times come from `originalAudioMapping`, which already carries the
   * padding/shift audio alignment, falling back to `analysisResults.beats`.
   */
  const promptExportInput = useMemo<PromptExportInput | null>(() => {
    if (!analysisResults || !chordGridData) return null;
    const gridChords = chordGridData.chords ?? [];
    if (gridChords.length === 0) return null;

    const mapping = chordGridData.originalAudioMapping ?? [];
    const beats: Array<number | null> = mapping.length === gridChords.length
      ? mapping.map((item) => item.timestamp)
      : (analysisResults.beats ?? []).map((beat) =>
          typeof beat === 'number' ? beat : beat?.time ?? null
        );

    return {
      trackName: audioFile?.name ?? null,
      durationSeconds: duration || analysisResults.audioDuration || null,
      bpm: analysisResults.beatDetectionResult?.bpm ?? null,
      timeSignature: analysisResults.beatDetectionResult?.time_signature ?? 4,
      keySignature,
      keyConfidence,
      chords: gridChords,
      beats,
      hasPadding: chordGridData.hasPadding,
      paddingCount: chordGridData.paddingCount,
      shiftCount: chordGridData.shiftCount,
      romanNumerals: romanNumerals ?? null,
      modulations: keyModulations ?? [],
      chordModel: analysisResults.chordModel ?? null,
      beatModel: analysisResults.beatModel ?? null,
      engine: 'music21 + harte-library + madmom-key-cnn',
    };
  }, [
    analysisResults,
    chordGridData,
    audioFile?.name,
    duration,
    keySignature,
    keyConfidence,
    romanNumerals,
    keyModulations,
  ]);

  // Beat animation tracking for HTML audio elements
  useEffect(() => {
    if (!analysisResults || !chordGridData || chordGridData.chords.length === 0) {
      return;
    }

    const rafRef = { current: undefined as number | undefined };

    const updateBeatTracking = () => {
      // Stop scheduling when not playing to save battery
      if (!isPlaying) {
        return;
      }

      if (!audioRef.current) {
        rafRef.current = requestAnimationFrame(updateBeatTracking);
        return;
      }

      // Use audio element's currentTime directly for most accurate timing
      const time = audioRef.current.currentTime;

      // Only update beat index when playing
      if (isPlaying) {
        // Find current beat index based on time
        let newBeatIndex = -1;

        if (chordGridData.beats && chordGridData.beats.length > 0) {
          // FIXED: Handle (number | null)[] format correctly
          for (let i = 0; i < chordGridData.beats.length; i++) {
            const beatTime = chordGridData.beats[i];

            // Skip null entries (padding/shift beats)
            if (beatTime === null) {
              continue;
            }

            if (typeof beatTime === 'number' && time >= beatTime) {
              newBeatIndex = i;
            } else if (typeof beatTime === 'number') {
              // Stop when we find a beat time that's greater than current time
              break;
            }
          }


        }

        // Update beat index if it changed
        if (newBeatIndex !== currentBeatIndexRef.current && newBeatIndex >= 0) {
          currentBeatIndexRef.current = newBeatIndex;
          setCurrentBeatIndex(newBeatIndex);
        }
      }

      if (isPlaying) {
        rafRef.current = requestAnimationFrame(updateBeatTracking);
      }
    };

    // Start the animation loop only when playing
    if (isPlaying) {
      rafRef.current = requestAnimationFrame(updateBeatTracking);
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, analysisResults]); // CRITICAL FIX: Intentionally limited dependencies to prevent animation loop restarts

  // FIXED: Auto-scroll with layout stability for superscript rendering

  // UtilityBar metronome toggle handler
  const handleMetronomeToggle = async (): Promise<boolean> => {
    const newEnabled = await toggleMetronomeWithSync();
    setIsMetronomeEnabled(newEnabled);
    return newEnabled;
  };

  useEffect(() => {
    if (!isFollowModeEnabled || currentBeatIndex === -1) return;

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // Throttle scrolls to at most ~1/sec to reduce layout thrashing
    if (now - lastScrollTimeRef.current < 1000) {
      return;
    }

    const beatElement = document.getElementById(`chord-${currentBeatIndex}`);
    if (beatElement) {
      // Wait for layout stability before scrolling to prevent jitter
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          lastScrollTimeRef.current = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          beatElement.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'nearest'
          });
        });
      });
    }
  }, [currentBeatIndex, isFollowModeEnabled]);



  // Metronome synchronization hook - use duration from audio element
  const { toggleMetronomeWithSync } = useMetronomeSync({
    currentBeatIndex,
    chordGridBeats: chordGridData.beats || [],
    currentTime,
    isPlaying,
    timeSignature: analysisResults?.beatDetectionResult?.time_signature || 4,
  });

  // Note: Beat click handling is managed internally by ChordGrid component via Zustand
  // No need for explicit handleBeatClick prop in upload page


  // Loop playback selectors (UI store)
  const isLoopEnabled = useIsLoopEnabled();
  const loopStartBeat = useLoopStartBeat();
  const loopEndBeat = useLoopEndBeat();

  // HTML Audio loop playback for upload page
  useEffect(() => {
    if (!isLoopEnabled || !audioRef.current) return;
    const beats = (simplifiedChordGridData?.beats || []) as Array<number | null>;
    if (!beats.length) return;
    const resolvedLoopRange = resolveLoopRange(beats, loopStartBeat, loopEndBeat, duration);
    if (!resolvedLoopRange) return;

    if (typeof currentTime === 'number' && currentTime >= resolvedLoopRange.endBoundary) {
      try {
        audioRef.current.currentTime = resolvedLoopRange.startTimestamp;
        // Maintain play state for seamless looping
        if (isPlaying) audioRef.current.play?.();
      } catch {}
    }
  }, [isLoopEnabled, loopStartBeat, loopEndBeat, currentTime, duration, simplifiedChordGridData?.beats, isPlaying]);

  // Inform UI store about original audio availability (enables pitch shift/UI)
  useEffect(() => {
    try {
      useUIStore.getState().initializeLocalAudioAvailable(Boolean(audioRef.current || audioProcessingState.audioUrl));
    } catch {}
  }, [audioProcessingState.audioUrl]);


  // Reset countdown flags when playback is paused
  useEffect(() => {
    if (!isPlaying) {
      cancelCountdown();
      countdownStateRef.current.completed = false;
      countdownStateRef.current.inProgress = false;
    }
  }, [isPlaying, cancelCountdown]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      // Abort any active countdown interval
      cancelCountdown();
      // Clear any pending stage timeout
      if (stageTimeoutRef.current) {
        clearTimeout(stageTimeoutRef.current);
        stageTimeoutRef.current = null;
      }

      useUIStore.getState().resetAnalysisUtilityBarState();
      usePlaybackStore.getState().setIsFollowModeEnabled(true);
      disableMetronomeService();
    };
  }, [cancelCountdown, disableMetronomeService]);


  // Initialize Zustand stores with page state
  // CRITICAL: Do NOT include Zustand-managed state (showRomanNumerals, simplifyChords) in dependencies
  // as that creates a circular loop causing race conditions during playback
  useEffect(() => {
    const analysisStore = useAnalysisStore.getState();
    const playbackStore = usePlaybackStore.getState();

    // Initialize AnalysisStore with local audio upload state
    analysisStore.setAnalysisResults(analysisResults);
    analysisStore.setIsAnalyzing(audioProcessingState.isAnalyzing);
    analysisStore.setAnalysisError(audioProcessingState.error || null);

    // Cache/model stubs (unused on the upload page, kept for consistency)
    analysisStore.setCacheAvailable(false);
    analysisStore.setCacheCheckCompleted(true);
    analysisStore.setCacheCheckInProgress(false);
    analysisStore.setModelsInitialized(true);
    // Local lyrics (a lyric file the user picked, or lyric tags embedded in the
    // audio) are mirrored into the store so other surfaces can read them.
    analysisStore.setLyrics(lyrics);
    analysisStore.setShowLyrics(showLyrics);
    analysisStore.setHasCachedLyrics(hasCachedLyrics);
    analysisStore.setIsTranscribingLyrics(false);
    analysisStore.setLyricsError(null);

    // Initialize PlaybackStore
    playbackStore.setIsPlaying(isPlaying);
    playbackStore.setCurrentTime(currentTime);
    playbackStore.setDuration(duration);
    playbackStore.setPlaybackRate(playbackRate);
    playbackStore.setYoutubePlayer(null); // No YouTube player in upload page
    playbackStore.setAudioRef(audioRef as React.RefObject<HTMLAudioElement>);
    // NOTE: currentBeatIndex is owned by playbackStore directly (see useCurrentBeatIndex
    // hook at top of component); do NOT re-mirror it here or you create a feedback loop.
  }, [
    // CRITICAL: Do NOT include showRomanNumerals, simplifyChords, or other Zustand-managed state
    // Only include local state that needs to be synced to Zustand
    analysisResults, audioProcessingState.isAnalyzing, audioProcessingState.error,
    isPlaying, currentTime, duration, playbackRate,
    // Local lyrics: mirror them into the store whenever they change
    lyrics, showLyrics, hasCachedLyrics
  ]);

  // Keep lyrics with their cached analysis so reopening it brings them back
  // (see openCachedAnalysis). Keyed by the content-addressed audio id.
  useEffect(() => {
    const audioId = analysisResults?.audioId;
    if (!audioId || !lyrics || lyrics.lines.length === 0) return;
    void saveLyricsForAudio(audioId, lyrics, lyricsSourceName);
  }, [analysisResults?.audioId, lyrics, lyricsSourceName]);

  useEffect(() => {
    useAnalysisStore.getState().clearSheetSage();
    setIsMelodicTranscriptionPlaybackEnabled(false);
  }, [audioProcessingState.audioUrl, setIsMelodicTranscriptionPlaybackEnabled]);

  return (
    <div className="min-h-screen bg-background dark:bg-gray-900">
      <div className="flex flex-col min-h-screen bg-background dark:bg-dark-bg transition-colors duration-300">
      {/* Use the Navigation component */}
      <Navigation />

      {/* Processing Status Banner */}
      <ProcessingStatusBanner
        audioUrl={audioProcessingState.audioUrl || undefined}
        beatDetector={beatDetector}
      />
      <MelodyTranscriptionStatusToast
        isComputing={isComputingSheetSage}
        durationSeconds={duration}
        hasResult={hasSheetSageNotes}
        errorMessage={sheetSageError}
      />

      <main className="flex-grow container mx-auto px-1 sm:px-2 md:px-3" style={{ maxWidth: "98%" }}>
        {/* Removed heading to reclaim vertical space */}

        <div className="flex flex-col gap-6">
          {/* Main content - Chord Grid (full width) */}
          <div className="w-full">
            <div className="p-6 h-full transition-colors duration-300">
              {/* Hidden audio element */}
              <audio ref={audioRef} className="hidden" controls={false} />
              <div className="flex flex-wrap items-center gap-4 md:gap-6 mb-4">
                {/* LEFT: Tabs inline (wraps on small screens) */}
                {analysisResults && (
                  <div className="flex-1 min-w-[260px] md:min-w-[420px]">
                    <ResultsTabs
                      activeTab={activeTab}
                      setActiveTab={setActiveTab}
                      showLyrics={showLyrics}
                      hasCachedLyrics={hasCachedLyrics}
                    />
                  </div>
                )}

                {/* RIGHT: File upload and Analyze controls */}
                <div className="flex flex-row gap-2 items-center ml-auto pl-2 md:pl-6">
                  <div className="relative inline-block">
                    <input
                      ref={audioFileInputRef}
                      type="file"
                      accept="audio/*"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    <Button
                      onClick={() => audioFileInputRef.current?.click()}
                      color="default"
                      variant="flat"
                      size="md"
                      className="font-medium"
                    >
                      {audioFile?.name ?? restoredAudioName ?? 'Choose Audio File'}
                    </Button>
                  </div>

                  {/* Local lyric sheet picker, same control as the audio picker */}
                  <div className="relative inline-block">
                    <input
                      ref={lyricsFileInputRef}
                      type="file"
                      accept=".lrc,.srt,.txt,.yaml,.yml"
                      onChange={handleLyricsFileChange}
                      className="hidden"
                    />
                    <Button
                      onClick={() => lyricsFileInputRef.current?.click()}
                      color="default"
                      variant="flat"
                      size="md"
                      className="font-medium"
                    >
                      {lyricsFile?.name ?? lyricsSourceName ?? 'Choose Lyrics File'}
                    </Button>
                  </div>

                  <Button
                    onClick={processAudioFile}
                    disabled={!audioFile || audioProcessingState.isExtracting || audioProcessingState.isAnalyzing || !!analysisDurationLimitReason}
                    color="primary"
                    variant="solid"
                    size="md"
                    className="font-medium bg-blue-600 hover:bg-blue-700 text-white border-blue-600 hover:border-blue-700 disabled:bg-gray-400 disabled:border-gray-400 disabled:text-gray-200"
                  >
                    {audioProcessingState.isExtracting ? 'Processing...' : 'Analyze Audio'}
                  </Button>
                </div>
              </div>

              {analysisDurationLimitReason && (
                <div className="mb-4 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
                  {analysisDurationLimitReason}
                </div>
              )}

              {/* Model Selectors - Hide when analysis is complete */}
              {!analysisResults && (
                <div className="flex flex-col md:flex-row gap-4 mb-4">
                  <HeroUIBeatModelSelector
                    onChange={setBeatDetector}
                    defaultValue={beatDetector}
                    className={audioProcessingState.isAnalyzing ? 'opacity-50 pointer-events-none' : ''}
                  />
                  <HeroUIChordModelSelector
                    selectedModel={chordDetector}
                    onModelChange={setChordDetector}
                    disabled={audioProcessingState.isAnalyzing}
                    className=""
                  />
                </div>
              )}

              {/* Local cache (local replacement for Firestore): stays visible as an empty state after clearing */}
              {!analysisResults && <LocalCachePanel onOpenAnalysis={openCachedAnalysis} />}

              {/* Audio Analysis Status Indicator - Hide when analysis is complete */}
              {!analysisResults && (
                <div className="flex items-center justify-end text-sm mb-4">
                  {audioProcessingState.isExtracting && (
                    <div className="flex items-center text-gray-600 dark:text-gray-300">
                      <div className="animate-spin h-4 w-4 border-2 border-primary-500 border-t-transparent rounded-full mr-2"></div>
                      <span>Extracting audio...</span>
                    </div>
                  )}

                  {audioProcessingState.isAnalyzing && (
                    <div className="flex items-center text-gray-600 dark:text-gray-300">
                      <div className="animate-spin h-4 w-4 border-2 border-primary-500 border-t-transparent rounded-full mr-2"></div>
                      <span>Analyzing chords & beats...</span>
                    </div>
                  )}

                  {audioProcessingState.error && (
                    <div className="text-red-500 flex items-center">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                      <span>{audioProcessingState.error}</span>
                    </div>
                  )}

                  {audioProcessingState.isAnalyzed && !audioProcessingState.isAnalyzing && (
                    <div className="text-green-600 flex items-center">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span>Analysis complete</span>
                    </div>
                  )}
                </div>
              )}

              {/* UtilityBar will be rendered inline below tabs together with the AudioPlaybackDock */}


              {/* Analysis Results Tabs moved inline above with controls */}
              {analysisResults && (
                <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-start">

                  <div className="min-w-0 flex-1">

                  {/* Tab content */}
                  <div className="tab-content">
                    {/* Beat & Chord Map Tab */}
                    {activeTab === 'beatChordMap' && (
                      <ScrollableTabContainer variant="plain" heightClass="h-[60vh] md:h-[66vh]">
                        <div className={`flex flex-col md:flex-row gap-4`}>
                          {/* Grid area */}
                          <div className={`w-full transition-all duration-200`}>
                            {/* Keeps the store's originalKey/targetKey in sync with
                                the detected key. Without this, enabling pitch shift
                                on the local-upload page displayed the store default
                                key ("C") instead of the detected key, because the
                                only other mount point is the [videoId] page. */}
                            <KeySignatureSync keySignature={keySignature} />
                            <ChordGridContainer
                              analysisResults={analysisResults}
                              chordGridData={simplifiedChordGridData}
                              // Roman numeral mapping must follow the stable,
                              // un-simplified sequence: the simplify toggle only
                              // rewrites chordGridData.chords for display.
                              originalChordsForRomanNumerals={chordGridData?.chords}
                              keySignature={keySignature}
                              isDetectingKey={isDetectingKey}
                              isChatbotOpen={isChatbotOpen}
                              isLyricsPanelOpen={isLyricsPanelOpen}
                              isUploadPage={true}
                              showCorrectedChords={showCorrectedChords}
                              chordCorrections={chordCorrections}
                              sequenceCorrections={sequenceCorrections}
                              segmentationData={segmentationData}
                              gridLyrics={gridTimedLyrics}
                            />
                            <div className="mt-3">
                              <BeatTimeline
                                beats={analysisResults?.beats || []}
                                downbeats={analysisResults?.downbeats || []}
                                currentBeatIndex={currentBeatIndex}
                                currentDownbeatIndex={-1}
                                duration={duration}
                              />
                            </div>
                          </div>

                        </div>
                      </ScrollableTabContainer>
                    )}

                    {/* Guitar Chords Tab */}
                    {activeTab === 'guitarChords' && (
                      <GuitarChordsTab
                        analysisResults={analysisResults}
                        chordGridData={simplifiedChordGridData}
                        keySignature={keySignature}
                        isDetectingKey={isDetectingKey}
                        isChatbotOpen={isChatbotOpen}
                        isLyricsPanelOpen={isLyricsPanelOpen}
                        isUploadPage={true}
                        showCorrectedChords={showCorrectedChords}
                        chordCorrections={chordCorrections}
                        sequenceCorrections={sequenceCorrections}
                        segmentationData={segmentationData}
                        isChordPlaybackEnabled={chordPlayback.isEnabled}
                        audioUrl={audioProcessingState.audioUrl || null}
                        gridLyrics={gridTimedLyrics}
                      />
                    )}

                    {/* Piano Visualizer Tab */}
                    {activeTab === 'pianoVisualizer' && (
                      <PianoVisualizerTab
                        analysisResults={analysisResults}
                        chordGridData={simplifiedChordGridData}
                        keySignature={keySignature}
                        showCorrectedChords={showCorrectedChords}
                        chordCorrections={chordCorrections}
                        sequenceCorrections={sequenceCorrections}
                        segmentationData={segmentationData}
                        currentTime={currentTime}
                        isPlaying={isPlaying}
                        isChordPlaybackEnabled={chordPlayback.isEnabled}
                        audioUrl={audioProcessingState.audioUrl || null}
                        sheetSageResult={sheetSageResult}
                        showMelodicOverlay={isMelodicTranscriptionPlaybackEnabled && hasSheetSageNotes}
                        gridLyrics={gridTimedLyrics}
                      />
                    )}

                    {activeTab === 'lyricsChords' && (
                      <LyricsSection
                        showLyrics={showLyrics}
                        lyrics={lyrics}
                        hasCachedLyrics={hasCachedLyrics}
                        currentTime={currentTime}
                        fontSize={fontSize}
                        theme={theme}
                        analysisResults={analysisResults}
                        onFontSizeChange={setFontSize}
                        segmentationData={segmentationData as unknown as ComponentProps<typeof LyricsSection>['segmentationData']}
                        sequenceCorrections={sequenceCorrections as unknown as ComponentProps<typeof LyricsSection>['sequenceCorrections']}
                      />
                    )}
                    </div>
                  </div>

                  {isLyricsPanelOpen && (
                    <div className="w-full lg:w-[20.5rem] lg:shrink-0 lg:sticky lg:top-4">
                      <LyricsPanel
                        embedded
                        isOpen={isLyricsPanelOpen}
                        onClose={() => setIsLyricsPanelOpen(false)}
                        videoTitle={audioFile?.name ?? restoredAudioName ?? undefined}
                        currentTime={currentTime}
                        lyrics={lyrics}
                        onClearLyrics={() => {
                          setLyrics(null);
                          setShowLyrics(false);
                          setHasCachedLyrics(false);
                          setLyricsSourceName(null);
                        }}
                        className="h-[calc(100vh-14rem)] min-h-[320px] max-h-[720px]"
                      />
                    </div>
                  )}

                </div>
              )}

              {/* Inline UtilityBar + AudioPlaybackDock (side-by-side, inline flow) */}
              {analysisResults && (
                <div className="mt-4">
                  <div className="flex flex-col md:flex-row md:items-center gap-3">
                    <div className="flex-1 min-w-[280px] overflow-x-auto">
                      <div className="inline-flex w-max min-w-full">
                        <UtilityBar
                          isFollowModeEnabled={isFollowModeEnabled}
                          chordPlayback={chordPlayback}
                          melodicTranscriptionPlayback={showSheetSage ? {
                            isEnabled: isMelodicTranscriptionPlaybackEnabled,
                            hasTranscription: hasSheetSageNotes,
                            isLoading: isComputingSheetSage || (isCheckingSheetSageBackend && !hasSheetSageNotes),
                            disabled: !hasSheetSageAudioSource,
                            disabledReason: melodicTranscriptionDisabledReason,
                            errorMessage: sheetSageBackendError || sheetSageError,
                            canAdjustVolume: hasSheetSageNotes,
                            togglePlayback: toggleMelodicTranscriptionPlayback,
                          } : undefined}
                          youtubePlayer={undefined}
                          playbackRate={playbackRate}
                          setPlaybackRate={(rate: number) => changePlaybackRate(rate)}
                          toggleFollowMode={toggleFollowMode}
                          isCountdownEnabled={isCountdownEnabled}
                          isCountingDown={isCountingDown}
                          countdownDisplay={countdownDisplay}
                          toggleCountdown={() => setIsCountdownEnabled(prev => !prev)}
                          isChatbotOpen={isChatbotOpen}
                          isLyricsPanelOpen={isLyricsPanelOpen}
                          toggleLyricsPanel={toggleLyricsPanel}
                          toggleChatbot={toggleChatbot}
                          segmentation={{
                            isVisible: showSegmentation && !!segmentationData,
                            hasData: !!segmentationData,
                            isLoading: isSegmenting,
                            disabled: !canAnalyzeSegmentation && !segmentationData,
                            disabledReason: !segmentationData ? segmentationDisabledReason : undefined,
                            errorMessage: segmentationError,
                            onToggle: handleSegmentationToggle,
                          }}
                          metronome={{
                            isEnabled: isMetronomeEnabled,
                            toggleMetronomeWithSync: handleMetronomeToggle,
                          }}
                          totalBeats={simplifiedChordGridData?.beats?.length || 0}
                          isUploadPage={true}
                          promptExport={promptExportInput ? {
                            input: promptExportInput,
                            trackName: audioFile?.name ?? null,
                          } : undefined}
                        />
                      </div>
                    </div>

                    <AudioPlaybackDock
                      isPlaying={isPlaying}
                      onTogglePlayPause={playPause}
                      playbackRate={playbackRate}
                      onChangePlaybackRate={changePlaybackRate}
                      currentTime={currentTime}
                      duration={duration}
                      onSeek={(t: number) => {
                        if (audioRef.current) {
                          try { audioRef.current.currentTime = t; } catch {}
                        }
                      }}
                      disabled={!audioFile && !audioProcessingState.audioUrl}
                      bpm={analysisResults?.beatDetectionResult?.bpm}
                    />
                  </div>

                  {/* Chord Playback Manager: manages state for UtilityBar mixer */}
                  <div className="mt-3">
                    <ChordPlaybackManager
                      currentBeatIndex={currentBeatIndex}
                      chordGridData={simplifiedChordGridData}
                      isPlaying={isPlaying}
                      currentTime={currentTime}
                      segmentationData={segmentationData}
                      audioUrl={audioProcessingState.audioUrl || null}
                      bpm={analysisResults?.beatDetectionResult?.bpm || 120}
                      timeSignature={timeSignature}
                      onChordPlaybackChange={handleChordPlaybackChange}
                    />
                  </div>

                </div>
              )}






            </div>
          </div>


        </div>
      </main>


      </div>

    </div>
  );
}

