'use client';

import type { AnalyzeSidePanelsProps } from '../_types/analyzePageViewModel';

/**
 * Side panel container.
 *
 * The AI chatbot that used to live here was removed: it required Gemini, which
 * is not available in the local-only build (FEATURE_SCOPE item 17).
 *
 * The component is kept as a no-op shell so the surrounding layout and the
 * props contract keep compiling.
 */
export default function AnalyzeSidePanels(_props: AnalyzeSidePanelsProps) {
  return null;
}
