/**
 * Theme preference helpers.
 *
 * The user picks one of three preferences: light, dark, or "system",
 * which follows the operating system's colour scheme. The resolved theme
 * is what the `dark` class on <html> reflects.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

export type ResolvedTheme = 'light' | 'dark';

/** localStorage key that holds the preference — also read by the blocking script in layout.tsx. */
export const THEME_STORAGE_KEY = 'theme';

/** Fired on the window after the preference changes, so every subscriber re-reads it. */
export const THEME_PREFERENCE_EVENT = 'chordmini:theme-preference';

/** Anything that is not an explicit light/dark choice means "follow the system". */
export function normalizeThemePreference(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Turn a preference into the theme that should be painted right now. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean
): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

/** Read the stored preference without throwing when storage is unavailable. */
export function readStoredPreference(
  storage: Pick<Storage, 'getItem'> | null | undefined
): ThemePreference {
  try {
    return normalizeThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/** Persist the preference; failures (private mode, disabled storage) are ignored. */
export function writeStoredPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Nothing to do: the in-memory preference still drives this tab.
  }
}