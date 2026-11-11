import {
  normalizeThemePreference,
  readStoredPreference,
  resolveTheme,
} from '@/utils/themePreference';

describe('theme preference helpers', () => {
  describe('normalizeThemePreference', () => {
    it('keeps explicit light and dark choices', () => {
      expect(normalizeThemePreference('light')).toBe('light');
      expect(normalizeThemePreference('dark')).toBe('dark');
    });

    it('treats anything else (system, missing, legacy values) as system', () => {
      expect(normalizeThemePreference('system')).toBe('system');
      expect(normalizeThemePreference(null)).toBe('system');
      expect(normalizeThemePreference(undefined)).toBe('system');
      expect(normalizeThemePreference('')).toBe('system');
      expect(normalizeThemePreference('auto')).toBe('system');
    });
  });

  describe('resolveTheme', () => {
    it('follows the system flag for the system preference', () => {
      expect(resolveTheme('system', true)).toBe('dark');
      expect(resolveTheme('system', false)).toBe('light');
    });

    it('ignores the system flag for explicit preferences', () => {
      expect(resolveTheme('light', true)).toBe('light');
      expect(resolveTheme('dark', false)).toBe('dark');
    });
  });

  describe('readStoredPreference', () => {
    it('reads the stored value', () => {
      const storage = { getItem: jest.fn(() => 'dark') };
      expect(readStoredPreference(storage)).toBe('dark');
    });

    it('falls back to system when storage throws', () => {
      const storage = {
        getItem: jest.fn(() => {
          throw new Error('storage disabled');
        }),
      };
      expect(readStoredPreference(storage)).toBe('system');
    });

    it('falls back to system when storage is missing', () => {
      expect(readStoredPreference(null)).toBe('system');
    });
  });
});