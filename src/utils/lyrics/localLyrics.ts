/**
 * Local-only lyrics sources for the offline ChordMini fork.
 *
 * Everything in this module is a pure, local computation: it parses text the
 * caller already has (LRC / SRT / plain text / YAML) or reads lyric tags out of
 * a user-supplied audio file with Uint8Array + DataView + TextDecoder.
 *
 * This is intentionally NOT the removed upstream cloud chain
 * (`@/services/lyrics/*`): no network calls, no Music.ai jobs, no server fetch.
 * Binary formats supported for embedded tags: ID3v2 (mp3, and the `id3 ` chunk
 * of WAV/RIFF), MP4/M4A `ilst` (`©lyr`), FLAC Vorbis comments, OGG Vorbis /
 * Opus comments.
 *
 * Environment note: the jsdom/jest test environment exposes neither
 * TextDecoder nor `File.prototype.text()` / `arrayBuffer()`, so this module
 * carries its own decoders and a FileReader fallback. Browsers use the native
 * TextDecoder when it is available.
 */
import { parse as parseYaml } from 'yaml';
import type { LyricLine, LyricsData } from '@/types/musicAiTypes';

/** How long a final, unterminated line is assumed to last when no duration is known. */
const DEFAULT_LAST_LINE_SECONDS = 5;
/** Smallest positive line duration, used to repair degenerate/inverted timings. */
const MIN_LINE_SECONDS = 0.25;
/** Plain-text synthesis step: line i spans [i * STEP, (i + 1) * STEP). */
const PLAIN_LINE_SECONDS = 2;
/** OGG comment headers are searched only in the first/last windows of this size. */
const OGG_SCAN_WINDOW_BYTES = 256 * 1024;
/** Safety bound on the number of frames / comments / boxes parsed. */
const MAX_ITERATIONS = 4096;

/** A line while it is still being built (endTime may still be unknown). */
interface DraftLine {
  startTime: number;
  endTime?: number;
  text: string;
  translation?: string;
  translationLanguage?: string;
}

function emptyLyrics(): LyricsData {
  return { lines: [] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function roundTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Bilingual lyric pairs
// ---------------------------------------------------------------------------
//
// Bilingual lyric files repeat every sung line twice (original and
// translation). Keeping them as two lines breaks chord placement: the chord
// pipeline assigns chords per line, so the second line ends up without chords,
// and the chord grid would render the same words twice. The pair is therefore
// folded into a single line: `text` holds the sung text, `translation` holds
// the other track, and both share one time range.

type ScriptName = 'kana' | 'hangul' | 'han' | 'latin';

interface ScriptCounts {
  kana: number;
  hangul: number;
  han: number;
  latin: number;
  total: number;
}

/** Inclusive code point ranges per script family. */
const KANA_RANGES: Array<[number, number]> = [
  [0x3040, 0x309f],
  [0x30a0, 0x30ff],
  [0x31f0, 0x31ff],
  [0xff66, 0xff9d],
];

const HANGUL_RANGES: Array<[number, number]> = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xac00, 0xd7af],
];

const HAN_RANGES: Array<[number, number]> = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
];

function inCodeRanges(code: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (code >= start && code <= end) {
      return true;
    }
  }
  return false;
}

function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = { kana: 0, hangul: 0, han: 0, latin: 0, total: 0 };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (inCodeRanges(code, KANA_RANGES)) {
      counts.kana += 1;
    } else if (inCodeRanges(code, HANGUL_RANGES)) {
      counts.hangul += 1;
    } else if (inCodeRanges(code, HAN_RANGES)) {
      counts.han += 1;
    } else if (
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a) ||
      (code >= 0x00c0 && code <= 0x024f)
    ) {
      counts.latin += 1;
    } else {
      continue; // punctuation, digits, symbols: not a script signal
    }
    counts.total += 1;
  }
  return counts;
}

/** The script family that carries most of the file, used to pick the sung text. */
function dominantScript(texts: string[]): ScriptName {
  const totals: ScriptCounts = { kana: 0, hangul: 0, han: 0, latin: 0, total: 0 };
  for (const text of texts) {
    const counts = countScripts(text);
    totals.kana += counts.kana;
    totals.hangul += counts.hangul;
    totals.han += counts.han;
    totals.latin += counts.latin;
    totals.total += counts.total;
  }
  if (totals.total === 0) {
    return 'latin';
  }
  // A little kana in the file means the lyrics themselves are Japanese, even
  // when most characters are kanji.
  if (totals.kana / totals.total >= 0.02) {
    return 'kana';
  }
  if (totals.hangul / totals.total >= 0.02) {
    return 'hangul';
  }
  return totals.han > totals.latin ? 'han' : 'latin';
}

function matchRatio(text: string, dominant: ScriptName): number {
  const counts = countScripts(text);
  if (counts.total === 0) {
    return 0;
  }
  return counts[dominant] / counts.total;
}

function inferLanguage(text: string): string | undefined {
  const counts = countScripts(text);
  if (counts.total === 0) {
    return undefined;
  }
  if (counts.kana > 0) {
    return 'ja';
  }
  if (counts.hangul > 0) {
    return 'ko';
  }
  if (counts.han > 0) {
    return 'zh';
  }
  return 'latin';
}

const SAME_START_TOLERANCE_SECONDS = 0.01;
const BILINGUAL_SEPARATOR_PATTERN = /\s+[|｜／]\s+/;
const LINE_BREAK_PATTERN = /\n+/;

/**
 * True when two texts look like the original and its translation: they differ
 * in script family in a way that only a translation would (Japanese kana vs
 * Chinese/English, Hangul vs anything else, CJK vs Latin). Two lines in the
 * same script are left alone, since that is far more likely to be two sung
 * lines than a translation.
 */
function isTranslationPair(first: string, second: string, dominant: ScriptName): boolean {
  const a = countScripts(first);
  const b = countScripts(second);
  if (a.total === 0 || b.total === 0) {
    return false;
  }
  if (first.trim() === second.trim()) {
    return false;
  }
  if ((a.kana > 0) !== (b.kana > 0)) {
    return true;
  }
  if ((a.hangul > 0) !== (b.hangul > 0)) {
    return true;
  }
  const aHan = a.han / a.total;
  const bHan = b.han / b.total;
  const aLatin = a.latin / a.total;
  const bLatin = b.latin / b.total;
  if (aHan > 0.5 && bLatin > 0.7) {
    return true;
  }
  if (bHan > 0.5 && aLatin > 0.7) {
    return true;
  }
  return Boolean(dominant === 'kana' && a.kana === 0 && b.kana === 0 && Math.abs(aHan - bHan) > 0.6);
}

/**
 * Splits one draft that carries both tracks (a multi-line subtitle cue or an
 * explicit `original | translation` separator) into separate drafts, so the
 * regular same-timestamp merge can fold them back into a single line.
 */
function expandBilingualDraft(draft: DraftLine, dominant: ScriptName): DraftLine[] {
  const rawParts = draft.text.includes('\n')
    ? draft.text.split(LINE_BREAK_PATTERN)
    : draft.text.split(BILINGUAL_SEPARATOR_PATTERN);
  const parts = rawParts.map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length < 2) {
    return [draft];
  }
  let foundPair = false;
  for (let i = 0; i + 1 < parts.length; i += 1) {
    if (isTranslationPair(parts[i], parts[i + 1], dominant)) {
      foundPair = true;
      break;
    }
  }
  if (!foundPair) {
    return [draft];
  }
  return parts.map((part) => ({
    startTime: draft.startTime,
    endTime: draft.endTime,
    text: part,
  }));
}

/**
 * Folds adjacent lines that share a start time and differ in script into one
 * line with a `translation`. Exported so cached lyrics can be migrated.
 */
export function mergeBilingualLines(lines: LyricLine[]): LyricLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }
  const dominant = dominantScript(lines.map((line) => line.text));
  const merged: LyricLine[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && !previous.translation
      && !line.translation
      && Math.abs(previous.startTime - line.startTime) <= SAME_START_TOLERANCE_SECONDS
      && isTranslationPair(previous.text, line.text, dominant)
    ) {
      const previousRatio = matchRatio(previous.text, dominant);
      const lineRatio = matchRatio(line.text, dominant);
      // The side that looks like the rest of the file is the sung text.
      const primary = lineRatio > previousRatio ? line : previous;
      const secondary = primary === previous ? line : previous;
      merged[merged.length - 1] = {
        ...primary,
        startTime: Math.min(primary.startTime, secondary.startTime),
        endTime: Math.max(primary.endTime, secondary.endTime),
        translation: secondary.text,
        translationLanguage: inferLanguage(secondary.text),
      };
      continue;
    }
    merged.push({ ...line });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Byte / text primitives
// ---------------------------------------------------------------------------

function readU32BE(bytes: Uint8Array, pos: number): number {
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
}

function readU32LE(bytes: Uint8Array, pos: number): number {
  return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
}

function readU24BE(bytes: Uint8Array, pos: number): number {
  return (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
}

/** ID3v2 sizes are stored as 4 syncsafe bytes (7 bits each). */
function readSyncSafe32(bytes: Uint8Array, pos: number): number {
  return (
    ((bytes[pos] & 0x7f) << 21) |
    ((bytes[pos + 1] & 0x7f) << 14) |
    ((bytes[pos + 2] & 0x7f) << 7) |
    (bytes[pos + 3] & 0x7f)
  );
}

function bytesToLatin1(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + length);
  for (let i = start; i < end; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function hasSignature(bytes: Uint8Array, offset: number, signature: string): boolean {
  if (offset + signature.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function indexOfBytes(haystack: Uint8Array, needle: number[], from: number): number {
  if (needle.length === 0 || haystack.length < needle.length) {
    return -1;
  }
  const limit = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= limit; i += 1) {
    let hit = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (haystack[i + k] !== needle[k]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      return i;
    }
  }
  return -1;
}

/** Manual UTF-8 decoding, used when the host has no TextDecoder (e.g. jsdom). */
function decodeUtf8Manual(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    let codePoint = 0;
    let extra = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      codePoint = b0 & 0x1f;
      extra = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      codePoint = b0 & 0x0f;
      extra = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      codePoint = b0 & 0x07;
      extra = 3;
    } else {
      out += '\ufffd';
      i += 1;
      continue;
    }
    if (i + extra >= bytes.length) {
      out += '\ufffd';
      break;
    }
    let valid = true;
    for (let k = 1; k <= extra; k += 1) {
      const bn = bytes[i + k];
      if ((bn & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (bn & 0x3f);
    }
    if (!valid) {
      out += '\ufffd';
      i += 1;
      continue;
    }
    i += extra + 1;
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      out += String.fromCharCode(codePoint);
    }
  }
  return out;
}

function decodeUtf16Manual(bytes: Uint8Array, littleEndian: boolean): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const codeUnit = littleEndian
      ? bytes[i] | (bytes[i + 1] << 8)
      : (bytes[i] << 8) | bytes[i + 1];
    out += String.fromCharCode(codeUnit);
  }
  return out;
}

function decodeLatin1Manual(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

type TextDecoderLike = new (label?: string) => { decode(input?: Uint8Array): string };

/** Decode with the native TextDecoder when present, else with the local fallback. */
function decodeBytes(label: 'utf-8' | 'utf-16le' | 'utf-16be' | 'iso-8859-1', bytes: Uint8Array): string {
  // jsdom exposes no TextDecoder, so this is looked up defensively at call time.
  const host = globalThis as unknown as { TextDecoder?: TextDecoderLike };
  const native = host.TextDecoder;
  if (typeof native === 'function') {
    try {
      return new native(label).decode(bytes);
    } catch {
      /* fall through to the manual decoder */
    }
  }
  if (label === 'utf-8') {
    return decodeUtf8Manual(bytes);
  }
  if (label === 'utf-16le') {
    return decodeUtf16Manual(bytes, true);
  }
  if (label === 'utf-16be') {
    return decodeUtf16Manual(bytes, false);
  }
  return decodeLatin1Manual(bytes);
}

/** Decode an ID3v2 text field using its 1-byte encoding descriptor. */
function decodeId3Text(data: Uint8Array, encoding: number): string {
  if (encoding === 1) {
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
      return decodeBytes('utf-16le', data.subarray(2));
    }
    if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
      return decodeBytes('utf-16be', data.subarray(2));
    }
    // Encoding byte 1 without a BOM: little-endian is the common real-world case.
    return decodeBytes('utf-16le', data);
  }
  if (encoding === 2) {
    return decodeBytes('utf-16be', data);
  }
  if (encoding === 3) {
    return decodeBytes('utf-8', data);
  }
  return decodeBytes('iso-8859-1', data);
}

// ---------------------------------------------------------------------------
// File reading (browser File API, with a FileReader fallback for jsdom)
// ---------------------------------------------------------------------------

/** Read a File as bytes without assuming `File.prototype.arrayBuffer()` exists. */
async function readFileBytes(file: File): Promise<Uint8Array | null> {
  if (!file) {
    return null;
  }
  const maybe = file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof maybe.arrayBuffer === 'function') {
    try {
      return new Uint8Array(await maybe.arrayBuffer());
    } catch {
      /* fall through to FileReader */
    }
  }
  if (typeof FileReader !== 'function') {
    return null;
  }
  return new Promise<Uint8Array | null>((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result: unknown = reader.result;
        if (result instanceof ArrayBuffer) {
          resolve(new Uint8Array(result));
          return;
        }
        // A jsdom FileReader may hand back a view from another realm.
        if (ArrayBuffer.isView(result)) {
          resolve(new Uint8Array(result.buffer as ArrayBuffer, result.byteOffset, result.byteLength));
          return;
        }
        resolve(null);
      };
      reader.onerror = () => resolve(null);
      reader.onabort = () => resolve(null);
      reader.readAsArrayBuffer(file);
    } catch {
      resolve(null);
    }
  });
}

/** Read a File as UTF-8 text without assuming `File.prototype.text()` exists. */
async function readFileText(file: File): Promise<string | null> {
  if (!file) {
    return null;
  }
  const maybe = file as unknown as { text?: () => Promise<string> };
  if (typeof maybe.text === 'function') {
    try {
      return await maybe.text();
    } catch {
      /* fall through to FileReader */
    }
  }
  if (typeof FileReader !== 'function') {
    return null;
  }
  return new Promise<string | null>((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        resolve(typeof result === 'string' ? result : null);
      };
      reader.onerror = () => resolve(null);
      reader.onabort = () => resolve(null);
      reader.readAsText(file, 'utf-8');
    } catch {
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Shared line assembly
// ---------------------------------------------------------------------------

/**
 * Credit / metadata lines that taggers and lyric sites put in front of the real
 * lyrics ("Lyrics by: ...", "Composer : ...") carry no sung text; they used to
 * flash on screen for the first second of playback, so they are dropped.
 *
 * The CJK labels are written as escapes so this source file stays ASCII-only.
 */
const LATIN_CREDIT_PATTERN =
  /^(?:lyrics?|lyricist|composer?|music|arranger?|arrangement|producer?|performer|artist|album|title|vocal(?:ist)?|singer|mixed|mastered|written|words)\b[^\uFF1A:\n]{0,24}[\uFF1A:]/i;

const CJK_CREDIT_WORDS = [
  '\u4f5c\u8bcd', // lyrics, simplified
  '\u4f5c\u8a5e', // lyrics, traditional
  '\u4f5c\u66f2', // composition
  '\u7f16\u66f2', // arrangement, simplified
  '\u7de8\u66f2', // arrangement, traditional
  '\u6f14\u5531', // performed by
  '\u6b4c\u624b', // singer
  '\u5236\u4f5c\u4eba', // producer
  '\u76d1\u5236', // supervisor, simplified
  '\u76e3\u88fd', // supervisor, traditional
  '\u8bcd', // lyrics label
  '\u8a5e', // lyrics label, traditional
  '\u66f2', // composition label
];

const CJK_CREDIT_ALTERNATION = CJK_CREDIT_WORDS.join('|');

const CJK_CREDIT_PATTERN = new RegExp(
  `^(?:${CJK_CREDIT_ALTERNATION})` +
    `(?:[\\u30fb/\\u3001&\\s]*(?:${CJK_CREDIT_ALTERNATION}))*` +
    '\\s*[\\uFF1A:]'
);

function isCreditLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return LATIN_CREDIT_PATTERN.test(trimmed) || CJK_CREDIT_PATTERN.test(trimmed);
}

/**
 * Drops credit lines from lyrics that were parsed before this filter existed
 * (cached entries), so replaying an old cache does not flash them either.
 */
export function dropCreditLines(lines: LyricLine[]): LyricLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }
  return lines.filter((line) => !isCreditLine(line.text));
}

/**
 * Sort drafts by start time (stable for equal timestamps) and fill in every
 * missing / degenerate endTime:
 *   - a line ends where the next one starts
 *   - the final line ends at the audio duration when that is known and later
 *     than its own start, otherwise DEFAULT_LAST_LINE_SECONDS after its start
 */
function finalizeLines(drafts: DraftLine[], durationSeconds?: number): LyricLine[] {
  const cleaned = drafts.filter((draft) => !isCreditLine(draft.text));
  const dominant = dominantScript(cleaned.map((draft) => draft.text));
  const indexed: Array<{ draft: DraftLine; index: number }> = [];
  cleaned.forEach((draft, index) => {
    for (const part of expandBilingualDraft(draft, dominant)) {
      indexed.push({ draft: part, index });
    }
  });
  indexed.sort((a, b) => {
    const delta = a.draft.startTime - b.draft.startTime;
    return delta !== 0 ? delta : a.index - b.index;
  });

  const lines: LyricLine[] = [];
  for (let i = 0; i < indexed.length; i += 1) {
    const current = indexed[i].draft;
    const next = i + 1 < indexed.length ? indexed[i + 1].draft : undefined;
    let end = current.endTime;
    if (!isFiniteNumber(end) || end <= current.startTime) {
      if (next) {
        end = next.startTime;
      } else if (isFiniteNumber(durationSeconds) && durationSeconds > current.startTime) {
        end = durationSeconds;
      } else {
        end = current.startTime + DEFAULT_LAST_LINE_SECONDS;
      }
      if (end <= current.startTime) {
        end = current.startTime + MIN_LINE_SECONDS;
      }
    }
    const line: LyricLine = {
      startTime: roundTime(current.startTime),
      endTime: roundTime(end),
      text: current.text,
    };
    if (current.translation) {
      line.translation = current.translation;
      line.translationLanguage = current.translationLanguage ?? inferLanguage(current.translation);
    }
    lines.push(line);
  }
  // Equal-timestamp pairs (bilingual lines) become one line with a translation.
  return mergeBilingualLines(lines);
}

// ---------------------------------------------------------------------------
// LRC
// ---------------------------------------------------------------------------

/** `[mm:ss.xx]`, `[mm:ss]` and the `[mm:ss:xx]` variant used by some taggers. */
const LRC_TIMESTAMP_SOURCE = '\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]';
const LRC_OFFSET_SOURCE = '\\[\\s*offset\\s*:\\s*([+-]?\\d+)\\s*\\]';

function fractionToSeconds(fraction: string | undefined): number {
  if (!fraction) {
    return 0;
  }
  const milliseconds = Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;
}

function lrcTimestampToSeconds(minutes: string, seconds: string, fraction?: string): number {
  return Number.parseInt(minutes, 10) * 60 + Number.parseInt(seconds, 10) + fractionToSeconds(fraction);
}

function looksLikeLrc(text: string): boolean {
  return new RegExp(LRC_TIMESTAMP_SOURCE).test(text);
}

function readLrcOffsetSeconds(text: string): number {
  const match = new RegExp(LRC_OFFSET_SOURCE, 'i').exec(text);
  if (!match) {
    return 0;
  }
  const milliseconds = Number.parseInt(match[1], 10);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;
}

/**
 * Parse LRC text: `[mm:ss.xx]` line timestamps, `[ar:]`/`[ti:]`/... ID tags
 * (ignored), several timestamps on one line (one output line each) and an
 * optional `[offset:±ms]` shift.
 */
export function parseLrc(text: string, durationSeconds?: number): LyricsData {
  if (typeof text !== 'string' || text.trim() === '') {
    return emptyLyrics();
  }
  try {
    const offsetSeconds = readLrcOffsetSeconds(text);
    const timestampPattern = new RegExp(LRC_TIMESTAMP_SOURCE, 'g');
    const drafts: DraftLine[] = [];
    const rawLines = text.replace(/\r\n?/g, '\n').split('\n');

    for (const rawLine of rawLines) {
      if (rawLine.trim() === '') {
        continue;
      }
      timestampPattern.lastIndex = 0;
      const stamps: number[] = [];
      let match = timestampPattern.exec(rawLine);
      while (match !== null) {
        stamps.push(lrcTimestampToSeconds(match[1], match[2], match[3]) + offsetSeconds);
        match = timestampPattern.exec(rawLine);
      }
      if (stamps.length === 0) {
        // Untimed prose and ID tags are not lyric lines. A hand-written LRC may
        // put a translation on its own line without a timestamp, but that cannot
        // be told apart from a wrapped continuation of a monolingual file, so it
        // is ignored instead of being guessed into `translation`. Bilingual files
        // with shared timestamps, multi-line cues and explicit separators are
        // handled below and in mergeBilingualLines.
        continue;
      }
      const content = rawLine.replace(timestampPattern, '').trim();
      if (content === '') {
        continue;
      }
      for (const stamp of stamps) {
        drafts.push({ startTime: stamp, text: content });
      }
    }
    return { lines: finalizeLines(drafts, durationSeconds) };
  } catch {
    return emptyLyrics();
  }
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

/** `HH:MM:SS,mmm` (the hour part is optional: hand-written cues often use `MM:SS,mmm`). */
const SRT_TIME_SOURCE = '(?:(\\d{1,3}):)?(\\d{2}):(\\d{2})[,.](\\d{1,3})';
const SRT_RANGE_SOURCE = `${SRT_TIME_SOURCE}\\s*-->\\s*${SRT_TIME_SOURCE}`;
const SRT_MARKUP_PATTERN = /<[^>]*>|\{\\[^}]*\}/g;

function srtTimestampToSeconds(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  fraction: string,
): number {
  const hourSeconds = hours ? Number.parseInt(hours, 10) * 3600 : 0;
  return (
    hourSeconds +
    Number.parseInt(minutes, 10) * 60 +
    Number.parseInt(seconds, 10) +
    fractionToSeconds(fraction)
  );
}

function cleanSubtitleText(text: string): string {
  return text
    .replace(SRT_MARKUP_PATTERN, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * Parse SRT subtitles: an optional sequence number, a
 * `HH:MM:SS,mmm --> HH:MM:SS,mmm` cue line (`.` also accepted) and one or more
 * text lines (joined with newlines, inline tags stripped).
 */
export function parseSrt(text: string, durationSeconds?: number): LyricsData {
  if (typeof text !== 'string' || text.trim() === '') {
    return emptyLyrics();
  }
  try {
    const rangePattern = new RegExp(SRT_RANGE_SOURCE);
    const normalized = stripBom(text).replace(/\r\n?/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    const drafts: DraftLine[] = [];

    for (const block of blocks) {
      const blockLines = block.split('\n');
      const rangeIndex = blockLines.findIndex((line) => rangePattern.test(line));
      if (rangeIndex < 0) {
        continue;
      }
      const rangeMatch = rangePattern.exec(blockLines[rangeIndex]);
      if (!rangeMatch) {
        continue;
      }
      const start = srtTimestampToSeconds(rangeMatch[1], rangeMatch[2], rangeMatch[3], rangeMatch[4]);
      const end = srtTimestampToSeconds(rangeMatch[5], rangeMatch[6], rangeMatch[7], rangeMatch[8]);
      const content = cleanSubtitleText(blockLines.slice(rangeIndex + 1).join('\n')).trim();
      if (content === '') {
        continue;
      }
      drafts.push({ startTime: start, endTime: end, text: content });
    }
    return { lines: finalizeLines(drafts, durationSeconds) };
  } catch {
    return emptyLyrics();
  }
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/**
 * Parse untimed lyrics: line i starts at i * 2s and ends at (i + 1) * 2s, the
 * same synthesis the removed upstream `normalizeLyricsResponse` used. Blank
 * lines are dropped before numbering, and `durationSeconds` only narrows an
 * end time so the last line cannot run past the audio.
 */
export function parsePlainLyrics(text: string, durationSeconds?: number): LyricsData {
  if (typeof text !== 'string' || text.trim() === '') {
    return emptyLyrics();
  }
  try {
    const contentLines = stripBom(text)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    const drafts: DraftLine[] = contentLines.map((line, index) => {
      const startTime = index * PLAIN_LINE_SECONDS;
      let endTime = (index + 1) * PLAIN_LINE_SECONDS;
      if (isFiniteNumber(durationSeconds) && durationSeconds > 0 && durationSeconds > startTime) {
        endTime = Math.min(endTime, durationSeconds);
      }
      return { startTime, endTime, text: line };
    });
    return { lines: finalizeLines(drafts, durationSeconds) };
  } catch {
    return emptyLyrics();
  }
}

// ---------------------------------------------------------------------------
// Uploaded lyrics file (.lrc / .srt / .txt / .yaml / .yml)
// ---------------------------------------------------------------------------

/** `mm:ss.xx` or a bare number of seconds, as found in YAML lyric sheets. */
function coerceTimeValue(raw: unknown): number | undefined {
  if (isFiniteNumber(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const value = raw.trim();
  if (value === '') {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  // SRT form first: three components with a millisecond fraction.
  const srtForm = new RegExp(`^${SRT_TIME_SOURCE}$`).exec(value);
  if (srtForm) {
    return srtTimestampToSeconds(srtForm[1], srtForm[2], srtForm[3], srtForm[4]);
  }
  // Then the bare LRC form (`mm:ss`, `mm:ss.xx`) and its bracketed spelling.
  const lrcForm = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(value);
  if (lrcForm) {
    return lrcTimestampToSeconds(lrcForm[1], lrcForm[2], lrcForm[3]);
  }
  const bracketedForm = new RegExp(`^${LRC_TIMESTAMP_SOURCE}$`).exec(value);
  if (bracketedForm) {
    return lrcTimestampToSeconds(bracketedForm[1], bracketedForm[2], bracketedForm[3]);
  }
  return undefined;
}

function extractYamlLineEntries(doc: unknown): unknown[] | null {
  if (Array.isArray(doc)) {
    return doc;
  }
  if (isRecord(doc) && Array.isArray(doc.lines)) {
    return doc.lines;
  }
  return null;
}

/** Parse a YAML lyric sheet shaped `{ lines: [{ time | startTime, text }] }`. */
function parseYamlLyrics(text: string, durationSeconds?: number): LyricsData {
  try {
    const doc: unknown = parseYaml(text);
    const entries = extractYamlLineEntries(doc);
    if (!entries) {
      return emptyLyrics();
    }
    const drafts: DraftLine[] = [];
    entries.forEach((entry, index) => {
      if (!isRecord(entry)) {
        if (typeof entry === 'string' && entry.trim() !== '') {
          drafts.push({
            startTime: index * PLAIN_LINE_SECONDS,
            endTime: (index + 1) * PLAIN_LINE_SECONDS,
            text: entry.trim(),
          });
        }
        return;
      }
      const rawText = typeof entry.text === 'string' ? entry.text : typeof entry.lyrics === 'string' ? entry.lyrics : '';
      if (rawText.trim() === '') {
        return;
      }
      const startTime = coerceTimeValue(entry.startTime ?? entry.time ?? entry.start) ?? index * PLAIN_LINE_SECONDS;
      const endTime = coerceTimeValue(entry.endTime ?? entry.end);
      drafts.push({ startTime, endTime, text: rawText.trim() });
    });
    return { lines: finalizeLines(drafts, durationSeconds) };
  } catch {
    return emptyLyrics();
  }
}

function fileExtension(file: File): string {
  const name = typeof file.name === 'string' ? file.name : '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Parse a user-uploaded lyrics file by extension: `.lrc` / `.srt` / `.txt` /
 * `.yaml` / `.yml`. Text that is valid UTF-8 with a BOM is handled; unknown or
 * missing extensions are sniffed by content. Never throws and never fetches.
 */
export async function parseLyricsFile(file: File): Promise<LyricsData> {
  try {
    if (!file) {
      return emptyLyrics();
    }
    const text = await readFileText(file);
    if (text === null) {
      return emptyLyrics();
    }
    const body = stripBom(text);
    if (body.trim() === '') {
      return emptyLyrics();
    }
    switch (fileExtension(file)) {
      case 'lrc':
        return parseLrc(body);
      case 'srt':
        return parseSrt(body);
      case 'yaml':
      case 'yml':
        return parseYamlLyrics(body);
      case 'txt':
      case 'text':
        return parsePlainLyrics(body);
      default:
        // Unknown/missing extension: sniff the content instead of guessing.
        if (looksLikeLrc(body)) {
          return parseLrc(body);
        }
        if (new RegExp(SRT_RANGE_SOURCE).test(body)) {
          return parseSrt(body);
        }
        return parsePlainLyrics(body);
    }
  } catch {
    return emptyLyrics();
  }
}

// ---------------------------------------------------------------------------
// Tag helpers shared by the embedded format parsers
// ---------------------------------------------------------------------------

/** Free text tag (LRC, SRT-ish or plain) -> LyricsData, or null when empty. */
function lyricsFromFreeText(text: string): LyricsData | null {
  const body = stripBom(text).trim();
  if (body === '') {
    return null;
  }
  const parsed = looksLikeLrc(body) ? parseLrc(body) : parsePlainLyrics(body);
  return parsed.lines.length > 0 ? parsed : null;
}

/** UTF-16 text fields terminate with 0x0000, other encodings with a single 0x00. */
function terminatorLength(encoding: number): number {
  return encoding === 1 || encoding === 2 ? 2 : 1;
}

function findTerminator(data: Uint8Array, from: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) {
        return i;
      }
    }
    return data.length;
  }
  for (let i = from; i < data.length; i += 1) {
    if (data[i] === 0) {
      return i;
    }
  }
  return data.length;
}

/** Reverse ID3v2 unsynchronisation (0xFF 0x00 -> 0xFF). */
function deUnsynchronise(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let written = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0xff && i + 1 < bytes.length && bytes[i + 1] === 0x00) {
      out[written] = 0xff;
      written += 1;
      i += 1;
    } else {
      out[written] = bytes[i];
      written += 1;
    }
  }
  return out.subarray(0, written);
}

// ---------------------------------------------------------------------------
// ID3v2 (mp3, and the `id3 ` chunk of WAV)
// ---------------------------------------------------------------------------

/** USLT: encoding(1) + language(3) + descriptor(NUL-terminated) + lyrics text. */
function parseUsltPayload(data: Uint8Array): string | null {
  if (data.length < 4) {
    return null;
  }
  const encoding = data[0];
  const rest = data.subarray(4);
  const terminator = findTerminator(rest, 0, encoding);
  const lyricsStart = Math.min(terminator + terminatorLength(encoding), rest.length);
  const text = decodeId3Text(rest.subarray(lyricsStart), encoding).replace(/\u0000+$/, '').trim();
  return text === '' ? null : text;
}

/**
 * SYLT: encoding(1) + language(3) + format(1) + contentType(1) +
 * descriptor(NUL-terminated) + repeated (text(NUL-terminated) + 4-byte BE
 * timestamp). Timestamps are milliseconds; `format` 2 is the ms variant and is
 * what this parser assumes.
 */
function parseSyltPayload(data: Uint8Array): DraftLine[] {
  if (data.length < 6) {
    return [];
  }
  const encoding = data[0];
  const rest = data.subarray(6);
  const descriptorEnd = findTerminator(rest, 0, encoding);
  let pos = Math.min(descriptorEnd + terminatorLength(encoding), rest.length);
  const drafts: DraftLine[] = [];

  for (let guard = 0; pos < rest.length && guard < MAX_ITERATIONS; guard += 1) {
    const textEnd = findTerminator(rest, pos, encoding);
    if (textEnd > rest.length) {
      break;
    }
    const text = decodeId3Text(rest.subarray(pos, textEnd), encoding).trim();
    const timestampPos = textEnd + terminatorLength(encoding);
    if (timestampPos + 4 > rest.length) {
      break; // truncated final entry
    }
    const milliseconds = readU32BE(rest, timestampPos);
    pos = timestampPos + 4;
    if (text === '') {
      continue;
    }
    drafts.push({ startTime: milliseconds / 1000, text });
  }
  return drafts;
}

function parseId3v2Tag(bytes: Uint8Array, offset: number): LyricsData | null {
  if (offset + 10 > bytes.length || !hasSignature(bytes, offset, 'ID3')) {
    return null;
  }
  const major = bytes[offset + 3];
  const flags = bytes[offset + 5];
  const size = readSyncSafe32(bytes, offset + 6);
  const bodyStart = offset + 10;
  if (bodyStart + size > bytes.length) {
    return null; // declared tag size runs past EOF -> treat as damaged
  }

  let body = bytes.subarray(bodyStart, bodyStart + size);
  if ((flags & 0x80) !== 0) {
    body = deUnsynchronise(body);
  }

  let pos = 0;
  if ((flags & 0x40) !== 0) {
    // Extended header: v2.4 stores its full size syncsafe, v2.3 stores size-4.
    if (body.length < 4) {
      return null;
    }
    if (major >= 4) {
      const extendedSize = readSyncSafe32(body, 0);
      if (extendedSize < 6 || extendedSize > body.length) {
        return null;
      }
      pos = extendedSize;
    } else {
      const extendedSize = readU32BE(body, 0);
      if (4 + extendedSize > body.length) {
        return null;
      }
      pos = 4 + extendedSize;
    }
  }

  const usltTexts: string[] = [];
  const syltDrafts: DraftLine[] = [];

  for (let guard = 0; pos < body.length && guard < MAX_ITERATIONS; guard += 1) {
    if (major === 2) {
      // ID3v2.2: 3-character frame ids, 3-byte big-endian sizes.
      if (pos + 6 > body.length) {
        break;
      }
      const frameId = bytesToLatin1(body, pos, 3);
      if (body[pos] === 0) {
        break; // padding
      }
      const frameSize = readU24BE(body, pos + 3);
      const dataStart = pos + 6;
      if (frameSize <= 0 || dataStart + frameSize > body.length) {
        break;
      }
      if (frameId === 'ULT' || frameId === 'USL') {
        const text = parseUsltPayload(body.subarray(dataStart, dataStart + frameSize));
        if (text !== null) {
          usltTexts.push(text);
        }
      }
      pos = dataStart + frameSize;
      continue;
    }

    if (pos + 10 > body.length) {
      break;
    }
    if (body[pos] === 0) {
      break; // padding
    }
    const frameId = bytesToLatin1(body, pos, 4);
    const frameSize = major >= 4 ? readSyncSafe32(body, pos + 4) : readU32BE(body, pos + 4);
    const frameFlags = (body[pos + 8] << 8) | body[pos + 9];
    const dataStart = pos + 10;
    if (frameSize <= 0 || dataStart + frameSize > body.length) {
      break; // truncated or absurd frame -> stop scanning
    }
    let frameData = body.subarray(dataStart, dataStart + frameSize);
    if (major >= 4) {
      if ((frameFlags & 0x0002) !== 0) {
        frameData = deUnsynchronise(frameData);
      }
      if ((frameFlags & 0x0001) !== 0 && frameData.length >= 4) {
        frameData = frameData.subarray(4); // data length indicator
      }
    }
    if (frameId === 'USLT') {
      const text = parseUsltPayload(frameData);
      if (text !== null) {
        usltTexts.push(text);
      }
    } else if (frameId === 'SYLT') {
      syltDrafts.push(...parseSyltPayload(frameData));
    }
    pos = dataStart + frameSize;
  }

  // Real synchronised timings win; otherwise an LRC payload inside USLT, and
  // finally untimed USLT text synthesised like plain lyrics.
  if (syltDrafts.length > 0) {
    return { lines: finalizeLines(syltDrafts) };
  }
  for (const text of usltTexts) {
    if (looksLikeLrc(text)) {
      const parsed = parseLrc(text);
      if (parsed.lines.length > 0) {
        return parsed;
      }
    }
  }
  if (usltTexts.length > 0) {
    const parsed = parsePlainLyrics(usltTexts[0]);
    if (parsed.lines.length > 0) {
      return parsed;
    }
  }
  return null;
}

/** WAV keeps an ID3v2 tag inside a RIFF `id3 ` chunk. */
function fromRiff(bytes: Uint8Array): LyricsData | null {
  let pos = 12; // 'RIFF' + size + 'WAVE'
  for (let guard = 0; pos + 8 <= bytes.length && guard < MAX_ITERATIONS; guard += 1) {
    const chunkId = bytesToLatin1(bytes, pos, 4);
    const chunkSize = readU32LE(bytes, pos + 4);
    const dataStart = pos + 8;
    if (chunkId === 'id3 ' || chunkId === 'ID3 ') {
      return parseId3v2Tag(bytes, dataStart);
    }
    if (chunkSize > bytes.length || dataStart + chunkSize > bytes.length) {
      break; // truncated chunk list
    }
    pos = dataStart + chunkSize + (chunkSize & 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// MP4 / M4A (`moov/udta/meta/ilst/©lyr`)
// ---------------------------------------------------------------------------

interface Mp4Box {
  type: string;
  dataStart: number;
  end: number;
}

/** Read one ISO-BMFF box; `size == 1` means a 64-bit size follows, `size == 0` means "to the end". */
function readMp4Box(bytes: Uint8Array, pos: number, limit: number): Mp4Box | null {
  if (pos + 8 > limit) {
    return null;
  }
  const size32 = readU32BE(bytes, pos);
  const type = bytesToLatin1(bytes, pos + 4, 4);
  let size = size32;
  let dataStart = pos + 8;
  if (size32 === 1) {
    if (pos + 16 > limit) {
      return null;
    }
    // No BigInt: combine the two halves manually (sizes here stay < 2^53).
    const high = readU32BE(bytes, pos + 8);
    const low = readU32BE(bytes, pos + 12);
    size = high * 4294967296 + low;
    dataStart = pos + 16;
  } else if (size32 === 0) {
    size = limit - pos;
  }
  if (size < dataStart - pos || pos + size > limit) {
    return null; // truncated box
  }
  return { type, dataStart, end: pos + size };
}

function findChildBox(
  bytes: Uint8Array,
  parentStart: number,
  parentEnd: number,
  wanted: string,
  skipFirstBytes: number,
): Mp4Box | null {
  let pos = parentStart + skipFirstBytes;
  for (let guard = 0; pos + 8 <= parentEnd && guard < MAX_ITERATIONS; guard += 1) {
    const box = readMp4Box(bytes, pos, parentEnd);
    if (!box) {
      return null;
    }
    if (box.type === wanted) {
      return box;
    }
    pos = box.end;
  }
  return null;
}

function lyricBoxInMeta(bytes: Uint8Array, meta: Mp4Box): Mp4Box | null {
  // 'meta' is a FullBox (4 version/flags bytes), but some QuickTime writers omit them.
  for (const skip of [4, 0]) {
    const ilst = findChildBox(bytes, meta.dataStart, meta.end, 'ilst', skip);
    if (!ilst) {
      continue;
    }
    const lyr = findChildBox(bytes, ilst.dataStart, ilst.end, '\u00a9lyr', 0);
    if (lyr) {
      return lyr;
    }
  }
  return null;
}

function fromMp4(bytes: Uint8Array): LyricsData | null {
  const moov = findChildBox(bytes, 0, bytes.length, 'moov', 0);
  if (!moov) {
    return null;
  }
  let lyricBox: Mp4Box | null = null;
  const udta = findChildBox(bytes, moov.dataStart, moov.end, 'udta', 0);
  if (udta) {
    const meta = findChildBox(bytes, udta.dataStart, udta.end, 'meta', 0);
    if (meta) {
      lyricBox = lyricBoxInMeta(bytes, meta);
    }
  }
  if (!lyricBox) {
    const metaDirect = findChildBox(bytes, moov.dataStart, moov.end, 'meta', 0);
    if (metaDirect) {
      lyricBox = lyricBoxInMeta(bytes, metaDirect);
    }
  }
  if (!lyricBox) {
    return null;
  }

  const dataBox = findChildBox(bytes, lyricBox.dataStart, lyricBox.end, 'data', 0);
  if (!dataBox) {
    return null;
  }
  const payloadStart = dataBox.dataStart + 8; // 4-byte data type + 4-byte locale
  if (payloadStart >= dataBox.end) {
    return null;
  }
  const dataType = readU32BE(bytes, dataBox.dataStart);
  if (dataType === 12 || dataType === 13 || dataType === 14) {
    return null; // GIF / JPEG / PNG payload, not text
  }
  const text = decodeBytes('utf-8', bytes.subarray(payloadStart, dataBox.end));
  return lyricsFromFreeText(text);
}

function looksLikeMp4(bytes: Uint8Array): boolean {
  const type = bytesToLatin1(bytes, 4, 4);
  return ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'styp', 'meta'].includes(type);
}

// ---------------------------------------------------------------------------
// Vorbis comments (FLAC and OGG Vorbis / Opus)
// ---------------------------------------------------------------------------

/**
 * Parse a Vorbis comment block: vendor length + vendor + comment count +
 * repeated (length + `KEY=value`). Returns the first lyric-ish value, preferring
 * LYRICS / UNSYNCEDLYRICS and falling back to any other `*LYRIC*` key.
 */
function parseVorbisComments(data: Uint8Array, base: number, limit: number): string | null {
  if (base + 4 > limit) {
    return null;
  }
  const vendorLength = readU32LE(data, base);
  let pos = base + 4 + vendorLength;
  if (pos + 4 > limit) {
    return null;
  }
  const commentCount = readU32LE(data, pos);
  pos += 4;
  if (commentCount > MAX_ITERATIONS) {
    return null;
  }

  let preferred: string | null = null;
  let fallback: string | null = null;
  for (let i = 0; i < commentCount; i += 1) {
    if (pos + 4 > limit) {
      break;
    }
    const length = readU32LE(data, pos);
    pos += 4;
    if (length > limit - pos) {
      break; // truncated comment
    }
    const entry = decodeBytes('utf-8', data.subarray(pos, pos + length));
    pos += length;
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator).trim().toUpperCase();
    const value = entry.slice(separator + 1);
    if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'UNSYNCED LYRICS') {
      if (preferred === null) {
        preferred = value;
      }
    } else if (fallback === null && key.includes('LYRIC')) {
      fallback = value;
    }
  }
  return preferred ?? fallback;
}

function fromFlac(bytes: Uint8Array): LyricsData | null {
  let pos = 4; // past 'fLaC'
  for (let guard = 0; pos + 4 <= bytes.length && guard < MAX_ITERATIONS; guard += 1) {
    const header = bytes[pos];
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockSize = readU24BE(bytes, pos + 1);
    const dataStart = pos + 4;
    if (dataStart + blockSize > bytes.length) {
      return null; // truncated metadata block
    }
    if (blockType === 4) {
      const text = parseVorbisComments(bytes, dataStart, dataStart + blockSize);
      return text === null ? null : lyricsFromFreeText(text);
    }
    if (isLast) {
      return null;
    }
    pos = dataStart + blockSize;
  }
  return null;
}

const VORBIS_COMMENT_MAGIC = [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // \x03vorbis
const OPUS_TAGS_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // OpusTags

/**
 * Vorbis/Opus comment headers sit either right after the first Ogg page or at
 * the tail of the stream, so only the first and last OGG_SCAN_WINDOW_BYTES are
 * searched (a proper page walk is deliberately not implemented).
 */
function fromOgg(bytes: Uint8Array): LyricsData | null {
  const windows: Array<{ start: number; end: number }> = [
    { start: 0, end: Math.min(bytes.length, OGG_SCAN_WINDOW_BYTES) },
  ];
  if (bytes.length > OGG_SCAN_WINDOW_BYTES) {
    windows.push({ start: bytes.length - OGG_SCAN_WINDOW_BYTES, end: bytes.length });
  }
  for (const window of windows) {
    const slice = bytes.subarray(window.start, window.end);
    const vorbisAt = indexOfBytes(slice, VORBIS_COMMENT_MAGIC, 0);
    if (vorbisAt >= 0) {
      const text = parseVorbisComments(slice, vorbisAt + VORBIS_COMMENT_MAGIC.length, slice.length);
      if (text !== null && text.trim() !== '') {
        return lyricsFromFreeText(text);
      }
    }
    const opusAt = indexOfBytes(slice, OPUS_TAGS_MAGIC, 0);
    if (opusAt >= 0) {
      const text = parseVorbisComments(slice, opusAt + OPUS_TAGS_MAGIC.length, slice.length);
      if (text !== null && text.trim() !== '') {
        return lyricsFromFreeText(text);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Read lyrics embedded in an audio file's tags. Returns null for anything it
 * does not recognise or cannot parse; never throws, never fetches.
 *
 * Supported: ID3v2.2/2.3/2.4 USLT + SYLT (mp3, WAV `id3 ` chunk), MP4/M4A
 * `moov/udta/meta/ilst/©lyr`, FLAC VORBIS_COMMENT, OGG Vorbis / Opus comments.
 */
export async function extractEmbeddedLyrics(file: File): Promise<LyricsData | null> {
  try {
    const bytes = await readFileBytes(file);
    if (!bytes || bytes.length < 10) {
      return null;
    }
    if (hasSignature(bytes, 0, 'ID3')) {
      return parseId3v2Tag(bytes, 0);
    }
    if (hasSignature(bytes, 0, 'RIFF')) {
      return fromRiff(bytes);
    }
    if (hasSignature(bytes, 0, 'fLaC')) {
      return fromFlac(bytes);
    }
    if (hasSignature(bytes, 0, 'OggS')) {
      return fromOgg(bytes);
    }
    if (bytes.length >= 12 && looksLikeMp4(bytes)) {
      return fromMp4(bytes);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Unified local lyrics entry point: an uploaded lyrics file wins, then tags
 * embedded in the audio file, otherwise null. Local-only; never throws.
 */
export async function resolveLocalLyrics(
  audioFile: File,
  lyricsFile?: File | null,
): Promise<{ data: LyricsData; source: 'lyrics-file' | 'embedded' } | null> {
  try {
    if (lyricsFile) {
      const data = await parseLyricsFile(lyricsFile);
      if (data.lines.length > 0) {
        return { data, source: 'lyrics-file' };
      }
    }
    if (!audioFile) {
      return null;
    }
    const embedded = await extractEmbeddedLyrics(audioFile);
    if (embedded && embedded.lines.length > 0) {
      return { data: embedded, source: 'embedded' };
    }
    return null;
  } catch {
    return null;
  }
}