'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  ReactNode,
} from 'react';
import {
  ResolvedTheme,
  THEME_PREFERENCE_EVENT,
  ThemePreference,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
} from '@/utils/themePreference';

interface ThemeContextType {
  /** The theme currently painted (resolution of the preference against the system). */
  theme: ResolvedTheme;
  /** What the user chose: light, dark, or system. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** Flip to the opposite of the theme currently painted, as an explicit choice. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

// -- useSyncExternalStore helpers --
// The painted theme lives in the 'dark' class on <html>, set by the blocking script
// in layout.tsx before first paint. useSyncExternalStore reads it without a hydration
// mismatch (the server snapshot is 'light').

function subscribeToTheme(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function getThemeSnapshot(): ResolvedTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function getServerThemeSnapshot(): ResolvedTheme {
  return 'light';
}

// The preference lives in localStorage. Writes go through setPreference, which also
// dispatches THEME_PREFERENCE_EVENT so this subscriber re-reads it in the same tab
// (the 'storage' event only fires in other tabs).

function subscribeToPreference(callback: () => void) {
  window.addEventListener(THEME_PREFERENCE_EVENT, callback);
  window.addEventListener('storage', callback);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', callback);
  return () => {
    window.removeEventListener(THEME_PREFERENCE_EVENT, callback);
    window.removeEventListener('storage', callback);
    media.removeEventListener('change', callback);
  };
}

function getPreferenceSnapshot(): ThemePreference {
  return readStoredPreference(window.localStorage);
}

function getServerPreferenceSnapshot(): ThemePreference {
  return 'system';
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

interface ThemeProviderProps {
  children: ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const theme = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getServerThemeSnapshot);
  const preference = useSyncExternalStore(
    subscribeToPreference,
    getPreferenceSnapshot,
    getServerPreferenceSnapshot
  );
  const themeSwitchTimerRef = useRef<number | null>(null);

  // Reveal the page once hydrated.
  useEffect(() => {
    document.body.classList.add('theme-ready');

    return () => {
      if (themeSwitchTimerRef.current !== null) {
        window.clearTimeout(themeSwitchTimerRef.current);
      }
    };
  }, []);

  // Keep the 'dark' class in sync with the preference, and follow the system while the
  // preference is 'system' (the media query listener fires when the OS switches).
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.classList.toggle(
        'dark',
        resolveTheme(preference, media.matches) === 'dark'
      );
    };

    apply();
    if (preference !== 'system') {
      return;
    }
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    if (themeSwitchTimerRef.current !== null) {
      window.clearTimeout(themeSwitchTimerRef.current);
    }

    document.documentElement.classList.add('theme-switching');
    writeStoredPreference(next);
    window.dispatchEvent(new Event(THEME_PREFERENCE_EVENT));

    themeSwitchTimerRef.current = window.setTimeout(() => {
      document.documentElement.classList.remove('theme-switching');
      themeSwitchTimerRef.current = null;
    }, 180);
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
  }, [setPreference]);

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};