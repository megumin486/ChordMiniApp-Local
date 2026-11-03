/**
 * AI prompt export entry point (FEATURE_SCOPE section 10 / item 27).
 *
 * Pure front end, zero network: reads the in-memory analysis result and
 * assembles a text blob.
 */

import { buildTimeline } from './analyze';
import { buildPromptExport } from './render';
import type { PromptExportInput, PromptExportOptions, PromptExportResult } from './types';

export type {
  PromptExportInput,
  PromptExportOptions,
  PromptExportResult,
  PromptTemplateId,
  PromptTimePrecision,
  PromptRomanNumerals,
} from './types';

export { buildTimeline, formatMmSs, measureStartSeconds } from './analyze';
export { buildPromptExport, estimateTokens, expandRunLength, GUARDRAIL_SENTENCE } from './render';

export function generatePromptExport(
  input: PromptExportInput,
  options: PromptExportOptions = {}
): PromptExportResult {
  const timeline = buildTimeline(input);
  return buildPromptExport(input, timeline, options);
}

/** Triggers a browser download. No network: plain Blob plus `<a download>`. */
export function downloadTextFile(
  text: string,
  filename: string,
  mimeType: string = 'text/markdown;charset=utf-8'
): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
