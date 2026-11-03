'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Chip,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectItem,
  Switch,
  Tooltip,
  addToast,
} from '@heroui/react';
import { motion } from 'framer-motion';
import { HiDocumentText, HiOutlineDocumentText, HiXMark } from 'react-icons/hi2';
import UtilityPopoverPanel from '@/components/analysis/UtilityPopoverPanel';
import { mergeToastClassNames } from '@/utils/toastStyles';
import {
  downloadTextFile,
  generatePromptExport,
  type PromptExportInput,
  type PromptTemplateId,
  type PromptTimePrecision,
} from '@/utils/promptExport';

/**
 * AI prompt export (FEATURE_SCOPE item 27).
 *
 * Deliberately built as a round utility-bar button plus a
 * `UtilityPopoverPanel` popover, matching `PitchShiftPopover`,
 * `ChordPlaybackToggle` and `LoopPlaybackToggle` rather than a standalone
 * Modal, so the panel chrome, rounding, shadow and dark-mode colours are the
 * ones the project already ships.
 *
 * No network, no model calls: it folds the current analysis result into a text
 * blob the user pastes into their own AI.
 */

const PRECISION_OPTIONS: Array<{ key: PromptTimePrecision; label: string; hint: string }> = [
  { key: 'section', label: 'Section', hint: 'Section skeleton and chord sets only, cheapest' },
  { key: 'measure', label: 'Measure', hint: 'Chord changes per measure, without beat positions' },
  { key: 'beat', label: 'Beat', hint: 'Per-beat timeline, including splits within a measure' },
];

const TEMPLATE_OPTIONS: Array<{ key: PromptTemplateId; label: string; hint: string }> = [
  { key: 'harmony', label: 'A. Harmony analysis', hint: 'Function, progressions, borrowing, section contrast' },
  { key: 'production', label: 'B. Arrangement', hint: '5 actionable arrangement / groove / reharm ideas' },
  { key: 'data', label: 'C. Data only', hint: 'Structured data with no role or task' },
];

const SEGMENTED_CONTROL_CLASS =
  'flex space-x-1 rounded-full bg-white/75 p-1 shadow-sm backdrop-blur dark:bg-gray-800/50';
const ACTIVE_SEGMENT_CLASS = 'bg-slate-900 text-white shadow-sm dark:bg-gray-900';
const INACTIVE_SEGMENT_CLASS =
  'text-gray-700 hover:bg-black/5 dark:text-gray-200 dark:hover:bg-white/10';

const SECTION_HEADING_CLASS =
  'text-xs font-bold uppercase tracking-[0.14em] text-gray-600 dark:text-gray-300';

interface PromptExportToggleProps {
  input: PromptExportInput;
  /** Redacted by default; only written when the user opts in (basename only). */
  trackName?: string | null;
  className?: string;
}

function formatDurationLabel(seconds: number | null | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const total = Math.round(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const PromptExportToggle: React.FC<PromptExportToggleProps> = ({
  input,
  trackName,
  className = '',
}) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [precision, setPrecision] = useState<PromptTimePrecision>('beat');
  const [template, setTemplate] = useState<PromptTemplateId>('harmony');
  const [includeAnchors, setIncludeAnchors] = useState(false);
  const [includeTrackName, setIncludeTrackName] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buttonClassName = `h-9 w-9 min-w-9 rounded-full shadow-md transition-colors duration-200 inline-flex items-center justify-center p-0 ${
    isPopoverOpen
      ? 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-gray-900'
      : 'bg-gray-200/60 dark:bg-gray-600/60 text-gray-700 dark:text-gray-200 hover:bg-gray-300/70 dark:hover:bg-gray-500/70'
  } ${className}`;

  const result = useMemo(
    () =>
      generatePromptExport(
        { ...input, trackName: trackName ?? input.trackName ?? null },
        { precision, template, includeAnchors, includeTrackName }
      ),
    [input, trackName, precision, template, includeAnchors, includeTrackName]
  );

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast({
        title: 'Copy Failed',
        description: 'The browser blocked clipboard access. Select the text and copy it manually.',
        color: 'default',
        timeout: 5000,
        shouldShowTimeoutProgress: true,
        classNames: mergeToastClassNames({
          icon: 'text-warning-500',
          title: 'text-warning-600 dark:text-warning-400',
        }),
      });
    }
  }, [result.text]);

  const handleDownload = useCallback(
    (format: 'md' | 'txt') => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadTextFile(
        result.text,
        `chordmini-prompt-${precision}-${stamp}.${format}`,
        format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
      );
    },
    [result.text, precision]
  );

  return (
    <Popover
      placement="top"
      offset={10}
      isOpen={isPopoverOpen}
      onOpenChange={setIsPopoverOpen}
      classNames={{
        content: 'p-0 border-none bg-transparent shadow-none',
      }}
    >
      <PopoverTrigger>
        <div className="relative inline-block">
          <Tooltip
            content="Export a prompt for your own AI"
            placement="top"
            delay={500}
            closeDelay={100}
            classNames={{
              content:
                'bg-white text-gray-900 dark:bg-content-bg dark:text-gray-100 border border-gray-300 dark:border-gray-600 shadow-lg',
            }}
          >
            <motion.button
              onClick={() => setIsPopoverOpen((open) => !open)}
              className={buttonClassName}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              aria-label="Export AI prompt"
              aria-pressed={isPopoverOpen}
            >
              {isPopoverOpen ? (
                <HiDocumentText className="h-4 w-4" />
              ) : (
                <HiOutlineDocumentText className="h-4 w-4" />
              )}
            </motion.button>
          </Tooltip>

          <div className="absolute -top-1 -right-1 bg-slate-500/70 dark:bg-slate-500/30 text-white text-[8px] px-1 py-0.5 rounded-full font-bold pointer-events-none">
            NEW
          </div>
        </div>
      </PopoverTrigger>

      <PopoverContent>
        <UtilityPopoverPanel
          title="AI Prompt Export"
          headerStartContent={
            <HiOutlineDocumentText className="h-5 w-5 text-slate-600 dark:text-slate-300" />
          }
          headerEndContent={
            <Button
              isIconOnly
              radius="sm"
              size="sm"
              variant="light"
              onPress={() => setIsPopoverOpen(false)}
              aria-label="Close AI prompt export"
              className="text-gray-500 dark:text-gray-400"
            >
              <HiXMark className="h-5 w-5" />
            </Button>
          }
          bodyClassName="overflow-y-auto max-h-[min(78vh,40rem)] w-[360px] space-y-3 p-3"
        >
          <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-300">
            Generated locally. No network calls, no model. Copy it into your own AI.
          </p>

          {/* Time precision: the three levels are mutually exclusive, one axis only */}
          <div className="space-y-1.5">
            <div className={SECTION_HEADING_CLASS}>Time precision</div>
            <div className={SEGMENTED_CONTROL_CLASS}>
              {PRECISION_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setPrecision(option.key)}
                  className={`flex-1 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                    precision === option.key ? ACTIVE_SEGMENT_CLASS : INACTIVE_SEGMENT_CLASS
                  }`}
                  aria-pressed={precision === option.key}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              {PRECISION_OPTIONS.find((option) => option.key === precision)?.hint}
            </p>
          </div>

          {/* Template: distinguished by task, not by writing style */}
          <div className="space-y-1.5">
            <div className={SECTION_HEADING_CLASS}>Template</div>
            <Select
              aria-label="Prompt template"
              size="sm"
              variant="bordered"
              color="primary"
              selectedKeys={[template]}
              onSelectionChange={(keys) => {
                const next = Array.from(keys)[0];
                if (typeof next === 'string') setTemplate(next as PromptTemplateId);
              }}
              classNames={{
                value: 'text-sm',
                trigger: 'bg-white/65 dark:bg-slate-900/35 border-white/25 dark:border-white/10',
              }}
            >
              {TEMPLATE_OPTIONS.map((option) => (
                <SelectItem key={option.key} description={option.hint} textValue={option.label}>
                  {option.label}
                </SelectItem>
              ))}
            </Select>
          </div>

          <div className="border-t border-white/20 dark:border-white/10" />

          <div className="flex flex-col gap-2">
            <Switch
              size="sm"
              color="primary"
              isSelected={includeAnchors}
              onValueChange={setIncludeAnchors}
            >
              Add time anchors (every 8 measures)
            </Switch>
            <Switch
              size="sm"
              color="primary"
              isSelected={includeTrackName}
              onValueChange={setIncludeTrackName}
            >
              Include track name (redacted by default)
            </Switch>
          </div>

          {/* Live statistics */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip size="sm" variant="flat">
              {result.stats.measures} {result.stats.measures === 1 ? 'measure' : 'measures'}
            </Chip>
            <Chip size="sm" variant="flat">
              {result.stats.beats} {result.stats.beats === 1 ? 'beat' : 'beats'}
            </Chip>
            <Chip size="sm" variant="flat">
              {result.stats.chordRuns} {result.stats.chordRuns === 1 ? 'change' : 'changes'}
            </Chip>
            <Chip size="sm" variant="flat">
              {result.stats.sections} {result.stats.sections === 1 ? 'section' : 'sections'}
            </Chip>
            <Chip size="sm" variant="flat" color={result.stats.modulations ? 'warning' : 'default'}>
              {result.stats.modulations} {result.stats.modulations === 1 ? 'modulation' : 'modulations'}
            </Chip>
          </div>
          <div className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            {result.charCount} chars · ~{result.approxTokens} tokens (estimated, not tokenizer-measured) · duration{' '}
            {formatDurationLabel(input.durationSeconds)}
          </div>

          {result.warnings.length > 0 && (
            <div className="w-full break-words rounded-lg border border-yellow-200 bg-yellow-50 p-2 text-[11px] leading-relaxed text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
              {result.warnings.map((warning) => (
                <div key={warning} className="break-words">- {warning}</div>
              ))}
            </div>
          )}

          <textarea
            readOnly
            value={result.text}
            aria-label="Generated prompt"
            className="h-56 w-full resize-none rounded-lg border border-gray-300 bg-white/70 p-2 font-mono text-[11px] leading-relaxed text-gray-800 backdrop-blur-sm dark:border-gray-600 dark:bg-slate-900/35 dark:text-gray-200"
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="flat" onPress={() => handleDownload('md')}>
              Export .md
            </Button>
            <Button size="sm" variant="flat" onPress={() => handleDownload('txt')}>
              Export .txt
            </Button>
            <Button size="sm" color="primary" onPress={handleCopy} className="ml-auto">
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </UtilityPopoverPanel>
      </PopoverContent>
    </Popover>
  );
};

export default memo(PromptExportToggle);
