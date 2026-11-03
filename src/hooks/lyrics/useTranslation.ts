import { useState, useCallback } from 'react';

/**
 * Lyrics translation hook — disabled.
 *
 * Lyrics translation (FEATURE_SCOPE item 20) relied on Gemini, which is not
 * available in the local-only build. The whole lyrics pipeline
 * (transcription / sync / translation / Lead Sheet, items 18-21) is dropped.
 *
 * The hook keeps the exact return shape required by `LyricsControls` so the
 * (no longer rendered) `LeadSheetDisplay` keeps compiling. No network request
 * is ever issued from here.
 */

export interface TranslatedLyrics {
  translatedLyrics: string;
  fromCache: boolean;
  backgroundUpdateInProgress?: boolean;
}

export interface LanguageOption {
  code: string;
  name: string;
}

interface UseTranslationParams {
  processedLines?: unknown[];
  getApiKey?: unknown;
  [key: string]: unknown;
}

export const useTranslation = (_params: UseTranslationParams) => {
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);

  const translateLyrics = useCallback(async (_targetLanguage: string): Promise<void> => {
    console.warn('[translation] Disabled in the local-only build; no request was sent.');
  }, []);

  return {
    translatedLyrics: {} as Record<string, TranslatedLyrics>,
    isTranslating: false,
    translationError: null as string | null,
    selectedLanguages,
    isLanguageMenuOpen,
    backgroundUpdatesInProgress: new Set<string>(),
    availableLanguages: [] as LanguageOption[],
    translateLyrics,
    setSelectedLanguages,
    setIsLanguageMenuOpen,
  };
};

export default useTranslation;
