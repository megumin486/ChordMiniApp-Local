"use client";

import type { ComponentProps } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { readAnalyzeRouteParams } from '@/utils/analyzeRouteUtils';
import ConditionalPlaybackControls from '@/components/chord-playback/ConditionalPlaybackControls';
import PitchShiftAudioManager from '@/components/chord-playback/PitchShiftAudioManager';
import KeySignatureSync from '@/components/analysis/KeySignatureSync';
import { ChordPlaybackManager } from '@/components/chord-playback/ChordPlaybackManager';
import AnalysisSplitLayout from '@/components/layout/AnalysisSplitLayout';
import AnalyzePageChrome from './_components/AnalyzePageChrome';
import AnalyzeResultsPane from './_components/AnalyzeResultsPane';
import AnalyzeSidePanels from './_components/AnalyzeSidePanels';
import AnalyzeFloatingDockSection from './_components/AnalyzeFloatingDockSection';
import { useAnalyzePageViewModel } from './_hooks/useAnalyzePageViewModel';
import dynamic from 'next/dynamic';
import { AnalysisControlsSkeleton } from '@/components/common/SkeletonLoaders';

const DynamicAnalysisControls = dynamic(
  () => import('@/components/analysis/AnalysisControls').then(mod => ({ default: mod.AnalysisControls })),
  {
    loading: () => <AnalysisControlsSkeleton />,
    ssr: false,
  }
);

export default function YouTubeVideoAnalyzePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const videoId = params?.videoId as string;
  const routeParams = readAnalyzeRouteParams(searchParams);
  const viewModel = useAnalyzePageViewModel({ videoId, routeParams });

  // YouTube URL analysis was dropped with the rest of the cloud pipeline
  // (FEATURE_SCOPE items 1-2): `extractAudio` is a throwing stub and nothing
  // writes the `chordmini_analyze_handoff` session key any more, so this route
  // can never produce results. Say so instead of rendering a shell that looks
  // like it is about to analyse something.
  const unavailableNotice = (
    <div className="relative z-40 border-b border-warning-200 bg-warning-50 px-4 py-3 dark:border-warning-500/30 dark:bg-warning-500/10">
      <div className="mx-auto flex max-w-5xl flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-warning-700 dark:text-warning-300">
          <span className="font-semibold">YouTube analysis is unavailable in this local build.</span>{' '}
          Search and audio extraction were removed together with the cloud pipeline. Upload a local audio file instead.
        </p>
        <a
          href="/analyze"
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Upload audio
        </a>
      </div>
    </div>
  );

  return (
    <div className="relative min-h-screen bg-background dark:bg-slate-900">
      {unavailableNotice}
      <ConditionalPlaybackControls
        youtubePlayer={viewModel.youtubePlayer}
        setIsPlaying={viewModel.setIsPlaying}
        setCurrentTime={viewModel.setCurrentTime}
        setAudioPlayerState={viewModel.setAudioPlayerState}
      >
        {() => (
          <>
            <PitchShiftAudioManager
              youtubePlayer={viewModel.youtubePlayer}
              audioRef={viewModel.audioRef}
              localAudioUrl={viewModel.audioUrl}
              isPlaying={viewModel.audioPlayerState.isPlaying}
              currentTime={viewModel.audioPlayerState.currentTime}
              playbackRate={viewModel.audioPlayerState.playbackRate}
              setIsPlaying={viewModel.setIsPlaying}
              setCurrentTime={viewModel.setCurrentTime}
            />

            <KeySignatureSync keySignature={viewModel.keySignature} />

            <ChordPlaybackManager
              currentBeatIndex={viewModel.currentBeatIndex}
              chordGridData={viewModel.chordGridData as unknown as ComponentProps<typeof ChordPlaybackManager>['chordGridData']}
              isPlaying={viewModel.audioPlayerState.isPlaying}
              currentTime={viewModel.audioPlayerState.currentTime}
              segmentationData={viewModel.segmentationData as unknown as ComponentProps<typeof ChordPlaybackManager>['segmentationData']}
              audioUrl={viewModel.audioUrl}
              bpm={viewModel.bpm}
              timeSignature={viewModel.timeSignature}
              onChordPlaybackChange={viewModel.handleChordPlaybackChange}
            />

            <div className="relative z-30 isolate flex min-h-screen flex-col overflow-hidden bg-background dark:bg-slate-900 transition-colors duration-300">
              <div className="relative z-10 flex min-h-screen flex-col">
                <AnalyzePageChrome {...viewModel.chromeProps} />

                <div className="relative z-20 flex-1 min-h-0">
                  <div className="px-4 pt-2 pb-1">
                    <div suppressHydrationWarning>
                      {/* suppressHydrationWarning keeps the shell stable while dynamic controls hydrate */}
                      <DynamicAnalysisControls {...viewModel.controlsProps} />
                    </div>
                  </div>

                  <div
                    className="min-h-0 px-4 pb-1 transition-[height] duration-300"
                    style={{ height: viewModel.splitLayoutHeight }}
                  >
                    <AnalysisSplitLayout
                      isSplit={viewModel.sidePanelsProps.isChatbotOpen}
                      storageKey="analysis-split-layout-sidepanels-v3"
                      defaultDesktopLayout={[60, 40]}
                      defaultMobileLayout={[66, 34]}
                      left={(
                        <div className="pr-2">
                          <AnalyzeResultsPane {...viewModel.resultsPaneProps} />
                        </div>
                      )}
                      right={<AnalyzeSidePanels {...viewModel.sidePanelsProps} />}
                    />
                  </div>
                </div>

                <AnalyzeFloatingDockSection
                  floatingDockProps={viewModel.floatingDockProps}
                  utilityBarProps={viewModel.utilityBarProps}
                />
              </div>
            </div>

            {viewModel.analysisResults ? (
              <div aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-24 z-0 h-28 overflow-hidden">
                {viewModel.chromeProps.analyzeBackdropUrl ? (
                  <div
                    className="absolute inset-[-18%] scale-110 bg-cover bg-center opacity-24 blur-3xl saturate-150 dark:opacity-28"
                    style={{ backgroundImage: `url("${viewModel.chromeProps.analyzeBackdropUrl}")` }}
                  />
                ) : null}
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/36 to-white/82 dark:via-slate-950/30 dark:to-slate-950/84" />
                <div className="absolute left-1/2 top-0 h-20 w-[92vw] max-w-[1180px] -translate-x-1/2 rounded-full bg-sky-400/10 blur-3xl dark:bg-sky-300/8" />
              </div>
            ) : null}
          </>
        )}
      </ConditionalPlaybackControls>
    </div>
  );
}
