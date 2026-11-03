'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { LocalCacheStats, RecentAnalysis } from '@/services/cache/localCacheClient';

/**
 * Local cache card (upload page).
 *
 * All three operations happen on this machine: analysis rows live in
 * `data/chordmini_cache.db`, audio bytes in `data/audio/`, and requests only go
 * to the same-origin `/api/local-cache`.
 *
 * Behaviour:
 *  - "Open" rebuilds the previous analysis page from the cache without re-running
 *    any model (via `/api/local-cache/restore`).
 *  - "Clear all" really clears everything (analyses + kv + audio) behind a second
 *    confirmation; the card does not disappear afterwards but shows an empty
 *    state, so the button never looks like it broke the page.
 *  - "Delete" removes one track's audio and analysis rows.
 */

interface LocalCachePayload {
  success: boolean;
  available: boolean;
  stats: LocalCacheStats | null;
  recent: RecentAnalysis[];
}

interface ClearResult {
  removedAnalyses: number;
  removedKvEntries: number;
  removedAudioFiles: number;
  removedAudioRows: number;
  freedBytes: number;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const megabytes = bytes / 1024 / 1024;
  if (megabytes < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (megabytes < 1024) return `${megabytes.toFixed(1)} MB`;
  return `${(megabytes / 1024).toFixed(2)} GB`;
}

function formatRelativeTime(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const elapsedSeconds = Date.now() / 1000 - unixSeconds;
  if (elapsedSeconds < 60) return 'just now';
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} min ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)} h ago`;
  return `${Math.floor(elapsedSeconds / 86400)} d ago`;
}

const KIND_LABELS: Record<string, string> = {
  chords: 'Chords',
  beats: 'Beats',
  harmony: 'Harmony',
};

/**
 * Remembers that "this machine has had a cache before".
 *
 * A fresh install should not show an empty card out of nowhere, but once the
 * user has cleared the cache once the empty state must stay in place (the card
 * vanishing entirely would look like the button broke the page).
 */
const SEEN_STORAGE_KEY = 'chordmini_cache_panel_seen';

function hasSeenCache(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SEEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function markCacheSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, '1');
  } catch {
    // localStorage may be unwritable in private mode; ignore it
  }
}

export default function LocalCachePanel({
  refreshKey,
  onOpenAnalysis,
}: {
  refreshKey?: number;
  /** Reopens a track's analysis page from the cache; read-only when omitted */
  onOpenAnalysis?: (audioId: string) => void | Promise<void>;
}) {
  const [payload, setPayload] = useState<LocalCachePayload | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [pendingClear, setPendingClear] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seenBefore, setSeenBefore] = useState(false);

  useEffect(() => {
    setSeenBefore(hasSeenCache());
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/local-cache', { cache: 'no-store' });
      const data = (await response.json()) as LocalCachePayload;
      setPayload(data);
      setError(null);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Once a cache has existed, remember it, so the card stays as an empty state after clearing.
  useEffect(() => {
    const statistics = payload?.stats;
    if (!statistics) return;
    if (statistics.analyses > 0 || statistics.audio.files > 0) {
      markCacheSeen();
      setSeenBefore(true);
    }
  }, [payload]);

  const handleClearAll = async () => {
    setIsBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/local-cache', { method: 'POST' });
      const data = (await response.json()) as { success: boolean; result: ClearResult | null };
      if (data.success && data.result) {
        const { removedAnalyses, removedAudioFiles, freedBytes } = data.result;
        setNotice(
          `Cleared ${removedAnalyses} analyses and ${removedAudioFiles} audio files, freeing ${formatBytes(freedBytes)}`,
        );
      } else {
        setNotice('Clear failed: the local cache service is unavailable');
      }
      await load();
    } catch (clearError) {
      setNotice(clearError instanceof Error ? clearError.message : 'Clear failed');
    } finally {
      setPendingClear(false);
      setIsBusy(false);
    }
  };

  const handleDeleteOne = async (audioId: string) => {
    setBusyId(audioId);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/local-cache?audioId=${encodeURIComponent(audioId)}`,
        { method: 'DELETE' },
      );
      const data = (await response.json()) as { success: boolean };
      if (!data.success) {
        setNotice('Delete failed: the local cache service is unavailable');
      }
      await load();
    } catch (deleteError) {
      setNotice(deleteError instanceof Error ? deleteError.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleOpen = async (audioId: string) => {
    if (!onOpenAnalysis) return;
    setBusyId(audioId);
    setNotice(null);
    try {
      await onOpenAnalysis(audioId);
    } catch (openError) {
      setNotice(openError instanceof Error ? openError.message : 'Open failed');
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return null;
  }

  const statistics = payload?.stats;
  const recent = payload?.recent ?? [];

  // First load has not returned yet: render nothing
  if (!payload) {
    return null;
  }

  const isEmpty = !statistics || (statistics.analyses === 0 && statistics.audio.files === 0);

  // Fresh install with no cache ever seen: keep the upload page clean and do not
  // render an empty card. seenBefore lives in state to avoid SSR/client mismatch.
  if (isEmpty && !notice && !seenBefore) {
    return null;
  }

  return (
    <div className="mb-4 w-full overflow-visible rounded-large border border-default-200/80 bg-content1/90 shadow-sm dark:border-gray-800/20">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <svg
            className="h-4 w-4 text-default-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7c0-1.657 3.582-3 8-3s8 1.343 8 3-3.582 3-8 3-8-1.343-8-3Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 1.657 3.582 3 8 3s8-1.343 8-3V7" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 12c0 1.657 3.582 3 8 3s8-1.343 8-3" />
          </svg>
          <span className="text-sm font-semibold text-foreground">Local cache</span>
          {statistics && (
            <span className="text-xs text-default-500">
              {statistics.analyses} analyses · audio {formatBytes(statistics.audio.bytes)} /{' '}
              {statistics.audio.budget_megabytes.toFixed(0)} MB
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {pendingClear ? (
            <>
              <span className="text-xs text-danger">Clear everything?</span>
              <Button size="sm" color="danger" variant="solid" isLoading={isBusy} onPress={handleClearAll}>
                Confirm
              </Button>
              <Button
                size="sm"
                variant="bordered"
                isDisabled={isBusy}
                onPress={() => setPendingClear(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="bordered"
              isDisabled={isBusy || isEmpty}
              onPress={() => setPendingClear(true)}
            >
              Clear all
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <p className="px-4 pb-3 text-xs text-default-600">{notice}</p>
      )}

      {isEmpty && !notice && (
        <p className="px-4 pb-3 text-xs text-default-500">
          No analyses are cached yet. Analyze a track and it will appear here, ready to reopen.
        </p>
      )}

      {recent.length > 0 && (
        <ul className="border-t border-default-200/60 dark:border-gray-800/30">
          {recent.slice(0, 4).map((entry) => {
            const audioId = entry.audio_id;
            const isRowBusy = busyId === audioId;
            return (
              <li
                key={entry.cache_key}
                className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-default-600"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-medium bg-default-100 px-1.5 py-0.5 text-[10px] font-medium text-default-600">
                    {KIND_LABELS[entry.kind] ?? entry.kind}
                  </span>
                  <span className="truncate text-foreground">{entry.title}</span>
                  {entry.keySignature && (
                    <span className="shrink-0 text-default-500">{entry.keySignature}</span>
                  )}
                  {entry.hits > 1 && <span className="shrink-0 text-default-400">×{entry.hits}</span>}
                </span>

                <span className="flex shrink-0 items-center gap-2">
                  {audioId && onOpenAnalysis && (
                    <Button
                      size="sm"
                      variant="light"
                      color="primary"
                      isLoading={isRowBusy}
                      onPress={() => handleOpen(audioId)}
                    >
                      Open
                    </Button>
                  )}
                  {audioId && (
                    <Button
                      size="sm"
                      variant="light"
                      color="danger"
                      isLoading={isRowBusy}
                      onPress={() => handleDeleteOne(audioId)}
                    >
                      Delete
                    </Button>
                  )}
                  <span className="w-16 text-right text-default-400">
                    {formatRelativeTime(entry.created_at)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
