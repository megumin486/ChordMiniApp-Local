'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@heroui/react';
import { HiInformationCircle, HiMusicalNote, HiTrash, HiXMark } from 'react-icons/hi2';
import AppTooltip from '@/components/common/AppTooltip';
import type { LyricsData, LyricLine } from '@/types/musicAiTypes';

/**
 * Floating lyrics panel, restored from the upstream component.
 *
 * The layout, animations and interactions are the upstream ones. The only
 * difference is the data source: upstream searched LRCLIB / Genius over the
 * network, while this local-only build displays the lyrics that are already
 * loaded (an embedded tag read from the audio file, or a .lrc / .srt / .txt
 * file picked on the Analyze page). Nothing here touches the network, and the
 * search box filters the loaded lines instead of querying a service.
 */
export interface LyricsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Title shown in the sticky header (usually the audio file name). */
  videoTitle?: string;
  /** Playback position in seconds, used to highlight and follow the line. */
  currentTime?: number;
  /** Locally loaded lyrics. */
  lyrics?: LyricsData | null;
  /** Called by the trash button; hides the panel state owner decides. */
  onClearLyrics?: () => void;
  embedded?: boolean;
  className?: string;
}

// Right-hand column, docked under the header and running to the bottom edge,
// the way the upstream lyrics panel sits next to the analysis surface.
const FLOATING_PANEL_CLASSES = 'w-[20.5rem] max-w-[calc(100vw-1rem)] max-sm:left-3 max-sm:right-3 max-sm:top-[4.5rem] max-sm:bottom-4 sm:right-4 sm:top-[4.5rem] sm:bottom-4 sm:w-[20.5rem] sm:max-w-[calc(100vw-2rem)]';

const formatTimestamp = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
};

const LyricsPanel: React.FC<LyricsPanelProps> = React.memo(({
  isOpen,
  onClose,
  videoTitle = '',
  currentTime = 0,
  lyrics = null,
  onClearLyrics,
  embedded = false,
  className = '',
}) => {
  const [displayMode, setDisplayMode] = useState<'sync' | 'static'>('sync');
  const [filterQuery, setFilterQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);
  const currentLineRef = useRef<HTMLDivElement>(null);

  const lines: LyricLine[] = lyrics?.lines ?? [];
  const hasTimedLines = useMemo(
    () => lines.some((line) => line.endTime > line.startTime),
    [lines],
  );
  const syncOn = hasTimedLines && displayMode === 'sync';

  const rows = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    return lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => (
        !query
        || line.text.toLowerCase().includes(query)
        || (line.translation ?? '').toLowerCase().includes(query)
      ));
  }, [lines, filterQuery]);

  const currentIndex = useMemo(() => {
    if (!syncOn) return -1;
    const found = lines.findIndex(
      (line) => currentTime >= line.startTime && currentTime <= line.endTime,
    );
    if (found !== -1) return found;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].startTime <= currentTime) return i;
    }
    return -1;
  }, [lines, currentTime, syncOn]);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !syncOn || !currentLineRef.current || !lyricsContainerRef.current) return;
    const container = lyricsContainerRef.current;
    const element = currentLineRef.current;
    const target = element.offsetTop - container.clientHeight / 2 + element.clientHeight / 2;
    // jsdom (and a few embedded browsers) do not implement scrollTo on elements.
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } else {
      container.scrollTop = Math.max(0, target);
    }
  }, [isOpen, syncOn, currentIndex]);

  const handleClear = () => {
    onClearLyrics?.();
  };

  const emptyState = (
    <div className="text-center text-gray-400 dark:text-gray-500 pt-12">
      <HiMusicalNote className="h-10 w-10 mx-auto mb-3 opacity-40" />
      <p className="text-sm">No lyrics loaded</p>
      <p className="mt-2 px-4 text-xs leading-relaxed">
        Pick a .lrc, .srt or .txt file on the Analyze page, or use an audio file with lyric
        tags embedded in it. Nothing is fetched from the network.
      </p>
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {!embedded && (
            <motion.div
              className="fixed inset-0 z-[9997] bg-black/20 backdrop-blur-[1px] sm:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={onClose}
            />
          )}
          <motion.div
            ref={panelRef}
            className={`
              ${embedded ? 'relative' : 'fixed max-sm:bottom-0 max-sm:right-0 max-sm:left-0'}
              ${embedded ? '' : 'z-[9998]'}
              isolate flex flex-col
              border border-white/45 dark:border-white/12
              shadow-[0_24px_60px_-28px_rgba(15,23,42,0.72)] rounded-xl overflow-hidden
              ${embedded ? 'w-full min-h-[400px]' : FLOATING_PANEL_CLASSES}
              ${className}
            `}
            initial={embedded ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 20 }}
            animate={embedded ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={embedded ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
          >
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-white/72 backdrop-blur-xl dark:bg-slate-900/42" />

            <div className="relative z-10 flex h-full flex-col">
              <div className="shrink-0 space-y-2.5 bg-white/34 px-4 pt-3 pb-3 backdrop-blur-md dark:bg-slate-900/12">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HiMusicalNote className="h-5 w-5 text-green-500" />
                    <h3 className="font-semibold text-gray-800 dark:text-white text-base">Song Lyrics</h3>
                    <AppTooltip
                      content="Sync timing may differ from the analyzed audio if using a different recording version."
                      placement="bottom-start"
                    >
                      <button
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-white"
                        aria-label="Lyrics sync timing info"
                      >
                        <HiInformationCircle className="h-4 w-4" />
                      </button>
                    </AppTooltip>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setDisplayMode(displayMode === 'sync' ? 'static' : 'sync')}
                      disabled={!hasTimedLines}
                      className={`px-2.5 py-1 text-[11px] rounded-full font-semibold transition-colors ${
                        syncOn
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                      } ${hasTimedLines ? '' : 'opacity-60 cursor-not-allowed'}`}
                    >
                      Sync: {syncOn ? 'On' : 'Off'}
                    </button>
                    <AppTooltip content="Clear lyrics">
                      <button
                        onClick={handleClear}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors"
                        aria-label="Clear lyrics"
                      >
                        <HiTrash className="h-4 w-4" />
                      </button>
                    </AppTooltip>
                    <button
                      onClick={onClose}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors"
                      aria-label="Close"
                    >
                      <HiXMark className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="flex gap-2">
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder="Search loaded lyrics..."
                    className="flex-1 rounded-lg border border-black/5 bg-white/72 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-green-500/60 dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:placeholder-gray-500"
                  />
                  <Button
                    size="sm"
                    color="success"
                    isDisabled={!filterQuery.trim()}
                    onPress={() => setFilterQuery(filterQuery.trim())}
                    className="font-semibold px-4"
                  >
                    Search
                  </Button>
                </div>
              </div>

              <div ref={lyricsContainerRef} className="relative flex-1 overflow-y-auto overscroll-contain">
                {videoTitle && (
                  <div className="sticky top-0 z-10 isolate overflow-hidden border-b border-white/20 dark:border-white/5">
                    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-white/55 backdrop-blur-xl dark:bg-slate-950/30" />
                    <div className="px-4 pt-2 pb-1.5">
                      <h4 className="font-semibold text-gray-900 dark:text-white text-sm leading-tight">{videoTitle}</h4>
                    </div>
                  </div>
                )}

                <div className={`px-4 ${syncOn ? 'pt-2 pb-28' : 'pb-4'}`}>
                  {rows.length === 0 && emptyState}

                  {rows.length > 0 && (
                    <div className="space-y-0.5">
                      {rows.map(({ line, index }) => {
                        const isCurrent = index === currentIndex;
                        const isPast = index < currentIndex;
                        return (
                          <div
                            key={`${index}-${line.startTime}`}
                            ref={isCurrent ? currentLineRef : undefined}
                            data-lyrics-index={index}
                            className={`flex items-start gap-3 py-2 px-3 rounded-lg transition-all duration-300 ${
                              isCurrent
                                ? 'border border-green-200/55 bg-green-50/55 dark:border-green-500/10 dark:bg-green-900/25 scale-[1.02]'
                                : ''
                            }`}
                          >
                            <span className={`text-[11px] tabular-nums mt-0.5 min-w-[3rem] shrink-0 ${
                              isCurrent
                                ? 'text-green-600 dark:text-green-400 font-semibold'
                                : isPast
                                  ? 'text-gray-500 dark:text-gray-600'
                                  : 'text-gray-500 dark:text-gray-500'
                            }`}>
                              {formatTimestamp(line.startTime)}
                            </span>
                            <div className="min-w-0">
                              <span className={`leading-relaxed transition-colors duration-300 ${
                                isCurrent
                                  ? 'text-gray-900 dark:text-white font-semibold'
                                  : isPast
                                    ? 'text-gray-500 dark:text-gray-500'
                                    : 'text-gray-700 dark:text-gray-400'
                              }`}>
                                {line.text || '\u266a'}
                              </span>
                              {line.translation && (
                                <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                                  {line.translation}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
});

LyricsPanel.displayName = 'LyricsPanel';
export default LyricsPanel;