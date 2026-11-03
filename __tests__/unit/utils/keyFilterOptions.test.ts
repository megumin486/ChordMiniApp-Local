import { KEY_OPTIONS } from '@/utils/keyFilterOptions';
import { ALL_KEYS_VALUE } from '@/services/query/recentVideos';

// The harmony engine stores keys with ASCII accidentals ("Eb major"), and the
// backend filter compares that string verbatim. A prettified value such as
// "E♭ major" would silently match nothing, so these values are pinned here.
const ASCII_KEY = /^[A-G][#b]? (major|minor)$/;

describe('keyFilterOptions', () => {
  it('offers every major and minor key plus the All Keys sentinel', () => {
    expect(KEY_OPTIONS).toHaveLength(25);
    expect(KEY_OPTIONS[0].value).toBe(ALL_KEYS_VALUE);
    const keyValues = KEY_OPTIONS.slice(1).map((option) => option.value);
    expect(keyValues).toHaveLength(24);
    for (const quality of ['major', 'minor']) {
      expect(keyValues.filter((value) => value.endsWith(` ${quality}`))).toHaveLength(12);
    }
  });

  it('uses ASCII accidentals so values match stored key signatures', () => {
    for (const option of KEY_OPTIONS.slice(1)) {
      expect(option.value).toMatch(ASCII_KEY);
      expect(option.value).not.toMatch(/[♭♯]/);
    }
  });

  it('keeps values unique and labels human readable', () => {
    const values = KEY_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    for (const option of KEY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});