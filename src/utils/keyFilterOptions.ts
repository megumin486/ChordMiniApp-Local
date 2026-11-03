import { ALL_KEYS_VALUE } from '@/services/query/recentVideos';

/**
 * Key choices for the homepage "Recently Transcribed Songs" filter.
 *
 * Values must use the ASCII spelling the harmony engine writes into SQLite
 * (`Eb major`, not `E♭ major`): the backend matches the stored key string
 * verbatim, so a prettified value would silently match nothing. Only the
 * labels are prettified for display.
 */
export interface KeyFilterOption {
  value: string;
  label: string;
}

export const KEY_OPTIONS: KeyFilterOption[] = [
  { value: ALL_KEYS_VALUE, label: 'All Keys' },
  { value: 'C major', label: 'C Major' },
  { value: 'C minor', label: 'C Minor' },
  { value: 'C# major', label: 'C# / D♭ Major' },
  { value: 'C# minor', label: 'D♭ / C# Minor' },
  { value: 'D major', label: 'D Major' },
  { value: 'D minor', label: 'D Minor' },
  { value: 'Eb major', label: 'D# / E♭ Major' },
  { value: 'Eb minor', label: 'E♭ Minor' },
  { value: 'E major', label: 'E Major' },
  { value: 'E minor', label: 'E Minor' },
  { value: 'F major', label: 'F Major' },
  { value: 'F minor', label: 'F Minor' },
  { value: 'F# major', label: 'F# / G♭ Major' },
  { value: 'F# minor', label: 'G♭ / F# Minor' },
  { value: 'G major', label: 'G Major' },
  { value: 'G minor', label: 'G Minor' },
  { value: 'Ab major', label: 'A♭ Major' },
  { value: 'Ab minor', label: 'G# / A♭ Minor' },
  { value: 'A major', label: 'A Major' },
  { value: 'A minor', label: 'A Minor' },
  { value: 'Bb major', label: 'B♭ Major' },
  { value: 'Bb minor', label: 'A# / B♭ Minor' },
  { value: 'B major', label: 'B Major' },
  { value: 'B minor', label: 'B Minor' },
];