import { useCallback } from 'react';
import { SegmentationResult, SongContext } from '@/types/chatbotTypes';
import { useUIStore } from '@/stores/uiStore';

/**
 * Segmentation state hook — disabled.
 *
 * SongFormer song segmentation (FEATURE_SCOPE item 12) was dropped: it needs a
 * separate Docker service plus large model weights, and the offline build does
 * not ship them.
 *
 * The hook keeps the same return shape so the analyse page keeps compiling, but
 * every action is a no-op and no external service is contacted.
 *
 * Note: `requestSongSegmentation` previously lived in the deleted
 * chatbotService module; it is intentionally NOT reintroduced here.
 */
export const useSegmentationState = () => {
  const showSegmentation = useUIStore((state) => state.showSegmentation);
  const setShowSegmentation = useUIStore((state) => state.setShowSegmentation);

  const runSegmentation = useCallback(async () => {
    console.warn('[segmentation] Disabled in the local-only build; no request was sent.');
    return null as SegmentationResult | null;
  }, []);

  const toggleSegmentation = useCallback((_songContext?: SongContext) => {
    // SongFormer segmentation is unavailable; keep the toggle purely local so
    // the UI state stays consistent without contacting any service.
    setShowSegmentation(!showSegmentation);
  }, [showSegmentation, setShowSegmentation]);

  const resetSegmentation = useCallback(() => {
    setShowSegmentation(false);
  }, [setShowSegmentation]);

  return {
    segmentationData: null as SegmentationResult | null,
    showSegmentation,
    isSegmenting: false,
    segmentationError: null as string | null,
    setShowSegmentation,
    runSegmentation,
    toggleSegmentation,
    resetSegmentation,
  };
};
