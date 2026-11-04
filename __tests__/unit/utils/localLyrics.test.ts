/**
 * Unit tests for the local-only lyrics module.
 *
 * Every binary fixture (ID3v2 USLT/SYLT, MP4 `©lyr`, FLAC/OGG Vorbis comments)
 * is built in-memory with Uint8Array helpers below — no binary files are added
 * to the repository. The test environment (jsdom) has no TextEncoder and no
 * `File.prototype.arrayBuffer()`, so the module's own decoders and its
 * FileReader fallback are what actually run here.
 */
import type { LyricsData } from '@/types/musicAiTypes';
import {
  dropCreditLines,
  extractEmbeddedLyrics,
  mergeBilingualLines,
  parseLrc,
  parseLyricsFile,
  parsePlainLyrics,
  parseSrt,
  resolveLocalLyrics,
} from '@/utils/lyrics/localLyrics';

// ---------------------------------------------------------------------------
// Byte-level fixture builders
// ---------------------------------------------------------------------------

function concat(...parts: number[][]): number[] {
  return parts.reduce<number[]>((acc, part) => acc.concat(part), []);
}

function u8(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/**
 * Copy fixture bytes into a standalone `ArrayBuffer`.
 * Newer DOM libs type `BlobPart` as `ArrayBufferView<ArrayBuffer>`, which a plain
 * `Uint8Array<ArrayBufferLike>` does not satisfy; jsdom accepts the buffer directly.
 */
function toArrayBuffer(values: number[]): ArrayBuffer {
  const bytes = u8(values);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function bytesToFile(values: number[], name: string, type = ''): File {
  return new File([toArrayBuffer(values)], name, { type });
}

function textToFile(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

function latin1Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    out.push(text.charCodeAt(i) & 0xff);
  }
  return out;
}

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return out;
}

function utf16leBytesWithBom(text: string): number[] {
  const out: number[] = [0xff, 0xfe];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out.push(unit & 0xff, (unit >> 8) & 0xff);
  }
  return out;
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u24be(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function syncSafe(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function zeros(count: number): number[] {
  return new Array(count).fill(0) as number[];
}

// --- ID3v2 -----------------------------------------------------------------

function id3Frame(frameId: string, payload: number[], version: 3 | 4): number[] {
  const size = version === 4 ? syncSafe(payload.length) : u32be(payload.length);
  return concat(latin1Bytes(frameId), size, [0, 0], payload);
}

function id3Tag(body: number[], major = 3, tagFlags = 0): number[] {
  return concat(latin1Bytes('ID3'), [major, 0, tagFlags], syncSafe(body.length), body);
}

/** USLT payload: encoding + language + descriptor + lyrics. */
function usltPayload(encoding: number, descriptor: number[], lyrics: number[]): number[] {
  return concat([encoding], latin1Bytes('eng'), descriptor, lyrics);
}

/** SYLT payload: encoding + language + format(2=ms) + contentType(1) + descriptor + entries. */
function syltPayload(entries: Array<{ text: string; ms: number }>): number[] {
  const head = concat([3], latin1Bytes('eng'), [2], [1], [0]);
  const body = entries.reduce<number[]>(
    (acc, entry) => acc.concat(utf8Bytes(entry.text), [0], u32be(entry.ms)),
    [],
  );
  return concat(head, body);
}

function mp3WithUslt(lrcText: string, major: 3 | 4, encoding: 3 | 1): number[] {
  const payload =
    encoding === 3
      ? usltPayload(3, [0], utf8Bytes(lrcText))
      : usltPayload(1, [0, 0], utf16leBytesWithBom(lrcText));
  const body = concat(
    id3Frame('TIT2', concat([3], utf8Bytes('Song')), major),
    id3Frame('USLT', payload, major),
  );
  return id3Tag(body, major);
}

function wavWithId3Chunk(tagValues: number[], restPad = 0): number[] {
  const chunk = concat(latin1Bytes('id3 '), u32le(tagValues.length), tagValues, zeros(restPad));
  return concat(latin1Bytes('RIFF'), u32le(4 + chunk.length), latin1Bytes('WAVE'), chunk);
}

// --- MP4 -------------------------------------------------------------------

function mp4Box(type: string, payload: number[], use64BitSize = false): number[] {
  if (use64BitSize) {
    return concat(u32be(1), latin1Bytes(type), u32be(0), u32be(payload.length + 16), payload);
  }
  return concat(u32be(8 + payload.length), latin1Bytes(type), payload);
}

/** moov/udta/meta/ilst/©lyr/data, with a 64-bit `mdat` ahead of it. */
function mp4WithLyrics(lyricsText: string): number[] {
  const dataBox = mp4Box('data', concat(u32be(1), u32be(0), utf8Bytes(lyricsText)));
  const ilst = mp4Box('ilst', mp4Box('\u00a9lyr', dataBox));
  const meta = mp4Box('meta', concat(zeros(4), ilst));
  const moov = mp4Box('moov', mp4Box('udta', meta));
  const ftyp = mp4Box('ftyp', concat(latin1Bytes('M4A '), u32be(0), latin1Bytes('M4A '), latin1Bytes('mp42')));
  const mdat = mp4Box('mdat', zeros(16), true);
  return concat(ftyp, mdat, moov);
}

// --- Vorbis comments -------------------------------------------------------

function vorbisCommentBody(comments: Array<[string, string]>): number[] {
  const vendor = utf8Bytes('ChordMiniLocal');
  const entries = comments.reduce<number[]>((acc, [key, value]) => {
    const entry = utf8Bytes(`${key}=${value}`);
    return acc.concat(u32le(entry.length), entry);
  }, []);
  return concat(u32le(vendor.length), vendor, u32le(comments.length), entries);
}

function flacWithVorbisComments(comments: Array<[string, string]>): number[] {
  const streamInfo = concat([0x00], u24be(34), zeros(34));
  const commentData = vorbisCommentBody(comments);
  const commentBlock = concat([0x84], u24be(commentData.length), commentData); // last block, type 4
  return concat(latin1Bytes('fLaC'), streamInfo, commentBlock);
}

function oggPage(packet: number[]): number[] {
  const segments = Math.ceil(packet.length / 255);
  const segmentTable: number[] = [];
  let remaining = packet.length;
  for (let i = 0; i < segments; i += 1) {
    const size = Math.min(255, remaining);
    segmentTable.push(size);
    remaining -= size;
  }
  return concat(
    latin1Bytes('OggS'),
    [0],
    [0x02],
    zeros(8), // granule position
    u32le(1),
    u32le(0),
    u32le(0), // serial, sequence, crc
    [segments],
    segmentTable,
    packet,
  );
}

function oggVorbisWith(comments: Array<[string, string]>): number[] {
  const packet = concat([0x03], latin1Bytes('vorbis'), vorbisCommentBody(comments));
  return concat(oggPage(packet), oggPage(concat(latin1Bytes('\x01vorbis'), zeros(4))));
}

function oggOpusWith(comments: Array<[string, string]>): number[] {
  const packet = concat(latin1Bytes('OpusTags'), vorbisCommentBody(comments));
  return oggPage(packet);
}

// ---------------------------------------------------------------------------
// LRC
// ---------------------------------------------------------------------------

describe('parseLrc', () => {
  it('parses [mm:ss.xx] timestamps and chains each line to the next start', () => {
    const data = parseLrc('[00:01.00]first line\n[00:03.50]second line');

    expect(data.lines).toEqual([
      { startTime: 1, endTime: 3.5, text: 'first line' },
      { startTime: 3.5, endTime: 8.5, text: 'second line' },
    ]);
  });

  it('uses the audio duration for the final line when it is provided', () => {
    const data = parseLrc('[00:01.00]only line', 42);
    expect(data.lines[0].endTime).toBe(42);
  });

  it('accepts [mm:ss] without a fraction and the [mm:ss:xx] variant', () => {
    const data = parseLrc('[00:02]plain seconds\n[00:04:25]colon fraction');
    expect(data.lines[0].startTime).toBe(2);
    expect(data.lines[1].startTime).toBeCloseTo(4.25, 5);
  });

  it('creates one line per timestamp when a line carries several', () => {
    const data = parseLrc('[00:01.00][00:05.00]repeated hook');
    expect(data.lines.map((line) => line.startTime)).toEqual([1, 5]);
    expect(data.lines.map((line) => line.text)).toEqual(['repeated hook', 'repeated hook']);
  });

  it('ignores metadata tags and keeps order stable for equal timestamps', () => {
    const data = parseLrc(
      ['[ar:Some Artist]', '[ti:Some Title]', '[al:Some Album]', '[00:01.00]a', '[00:01.00]b'].join('\n'),
    );
    expect(data.lines.map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('sorts out-of-order timestamps ascending', () => {
    const data = parseLrc('[00:03.00]third\n[00:01.00]first\n[00:02.00]second');
    expect(data.lines.map((line) => line.text)).toEqual(['first', 'second', 'third']);
  });

  it('applies a positive [offset:] shift to every timestamp', () => {
    const data = parseLrc('[offset:500]\n[00:01.00]shifted');
    expect(data.lines[0].startTime).toBeCloseTo(1.5, 5);
  });

  it('returns empty lines for blank, tag-only or non-lyric input', () => {
    expect(parseLrc('')).toEqual({ lines: [] });
    expect(parseLrc('   \n  ')).toEqual({ lines: [] });
    expect(parseLrc('just a sentence with no timestamps')).toEqual({ lines: [] });
    expect(parseLrc('[ar:Only Tags]')).toEqual({ lines: [] });
    expect(parseLrc('[00:05.00]')).toEqual({ lines: [] });
  });
});

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

describe('parseSrt', () => {
  it('parses numbered cues with comma decimals and keeps explicit end times', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:04,000', 'hello world', '', '2', '00:00:04,500 --> 00:00:07,250', 'next cue'].join('\n');
    const data = parseSrt(srt);

    expect(data.lines).toEqual([
      { startTime: 1, endTime: 4, text: 'hello world' },
      { startTime: 4.5, endTime: 7.25, text: 'next cue' },
    ]);
  });

  it('joins multi-line cue text and strips markup and entities', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:04,000', '<i>first</i>', 'second &amp; third'].join('\n');
    const data = parseSrt(srt);

    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].text).toBe('first\nsecond & third');
  });

  it('handles dot separators, missing sequence numbers and hour-less times', () => {
    const dotted = parseSrt('00:00:02.500 --> 00:00:03.500\nno index');
    expect(dotted.lines[0]).toEqual({ startTime: 2.5, endTime: 3.5, text: 'no index' });

    const hourless = parseSrt('1\n01:30,000 --> 02:00,000\nshort form');
    expect(hourless.lines[0]).toEqual({ startTime: 90, endTime: 120, text: 'short form' });
  });

  it('returns empty lines for input without a cue line', () => {
    expect(parseSrt('nothing here')).toEqual({ lines: [] });
    expect(parseSrt('')).toEqual({ lines: [] });
  });
});

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

describe('parsePlainLyrics', () => {
  it('synthesises 2-second lines in order', () => {
    const data = parsePlainLyrics('line one\nline two\nline three');
    expect(data.lines).toEqual([
      { startTime: 0, endTime: 2, text: 'line one' },
      { startTime: 2, endTime: 4, text: 'line two' },
      { startTime: 4, endTime: 6, text: 'line three' },
    ]);
  });

  it('drops blank lines before numbering and narrows to a known duration', () => {
    const data = parsePlainLyrics('first\n\n\nsecond', 3);
    expect(data.lines).toEqual([
      { startTime: 0, endTime: 2, text: 'first' },
      { startTime: 2, endTime: 3, text: 'second' },
    ]);
  });

  it('returns empty lines for blank input', () => {
    expect(parsePlainLyrics(' \n \n')).toEqual({ lines: [] });
  });
});

// ---------------------------------------------------------------------------
// parseLyricsFile
// ---------------------------------------------------------------------------

describe('parseLyricsFile', () => {
  it('dispatches .lrc / .srt / .txt by extension', async () => {
    const lrc = await parseLyricsFile(textToFile('[00:02.00]from lrc', 'song.lrc'));
    expect(lrc.lines[0]).toEqual({ startTime: 2, endTime: 7, text: 'from lrc' });

    const srt = await parseLyricsFile(textToFile('1\n00:00:01,000 --> 00:00:02,000\nfrom srt', 'song.srt'));
    expect(srt.lines[0]).toEqual({ startTime: 1, endTime: 2, text: 'from srt' });

    const txt = await parseLyricsFile(textToFile('from txt', 'song.txt'));
    expect(txt.lines[0]).toEqual({ startTime: 0, endTime: 2, text: 'from txt' });
  });

  it('parses the { lines: [{ time | startTime, text }] } YAML shape', async () => {
    const yaml = [
      'lines:',
      "  - time: '00:01.50'",
      '    text: first',
      '  - startTime: 5',
      '    text: second',
      '    endTime: 7',
    ].join('\n');

    const fromYaml = await parseLyricsFile(textToFile(yaml, 'song.yaml'));
    expect(fromYaml.lines).toEqual([
      { startTime: 1.5, endTime: 5, text: 'first' },
      { startTime: 5, endTime: 7, text: 'second' },
    ]);

    const fromYml = await parseLyricsFile(textToFile('lines:\n  - time: 3\n    text: third', 'song.yml'));
    expect(fromYml.lines[0]).toEqual({ startTime: 3, endTime: 8, text: 'third' });
  });

  it('sniffs unknown extensions and tolerates a BOM, empty and malformed files', async () => {
    const sniffedLrc = await parseLyricsFile(textToFile('[00:04.00]sniffed', 'song.dat'));
    expect(sniffedLrc.lines[0].text).toBe('sniffed');

    const bomText = `\ufefffirst\nsecond`;
    const withBom = await parseLyricsFile(textToFile(bomText, 'song.txt'));
    expect(withBom.lines[0].text).toBe('first');

    expect(await parseLyricsFile(textToFile('', 'empty.txt'))).toEqual({ lines: [] });
    expect(await parseLyricsFile(textToFile('lines: "not an array"', 'broken.yaml'))).toEqual({ lines: [] });
    expect(await parseLyricsFile(textToFile(': : : not yaml : :', 'broken.yaml'))).toEqual({ lines: [] });
  });
});

// ---------------------------------------------------------------------------
// Embedded tags: ID3v2
// ---------------------------------------------------------------------------

describe('extractEmbeddedLyrics — ID3v2', () => {
  it('reads an ID3v2.3 USLT frame holding LRC text (UTF-8)', async () => {
    const lrc = '[00:01.00]hello\n[00:03.50]world';
    const data = await extractEmbeddedLyrics(bytesToFile(mp3WithUslt(lrc, 3, 3), 'song.mp3'));

    expect(data).not.toBeNull();
    expect((data as LyricsData).lines).toEqual([
      { startTime: 1, endTime: 3.5, text: 'hello' },
      { startTime: 3.5, endTime: 8.5, text: 'world' },
    ]);
  });

  it('reads an ID3v2.4 USLT frame encoded as UTF-16 with a BOM and syncsafe frame size', async () => {
    const longTail = 'x'.repeat(200); // pushes the frame past 127 bytes so syncsafe != big-endian
    const lrc = `[00:01.00]你好\n[00:05.00]${longTail}`;
    const data = (await extractEmbeddedLyrics(bytesToFile(mp3WithUslt(lrc, 4, 1), 'song.mp3'))) as LyricsData;

    expect(data.lines).toHaveLength(2);
    expect(data.lines[0]).toEqual({ startTime: 1, endTime: 5, text: '你好' });
    expect(data.lines[1].text).toBe(longTail);
  });

  it('reads an ID3v2 SYLT frame and maps millisecond timestamps to seconds', async () => {
    const tag = id3Tag(
      concat(
        id3Frame('TIT2', concat([3], utf8Bytes('Song')), 3),
        id3Frame('SYLT', syltPayload([{ text: 'hello', ms: 1000 }, { text: 'world', ms: 3000 }]), 3),
      ),
      3,
    );
    const data = (await extractEmbeddedLyrics(bytesToFile(tag, 'song.mp3'))) as LyricsData;

    expect(data.lines).toEqual([
      { startTime: 1, endTime: 3, text: 'hello' },
      { startTime: 3, endTime: 8, text: 'world' },
    ]);
  });

  it('reads an ID3v2.2 ULT frame (3-character frame id)', async () => {
    const payload = usltPayload(3, [0], utf8Bytes('[00:02.00]legacy'));
    const frame = concat(latin1Bytes('ULT'), u24be(payload.length), payload);
    const data = (await extractEmbeddedLyrics(bytesToFile(id3Tag(frame, 2), 'song.mp3'))) as LyricsData;

    expect(data.lines[0]).toEqual({ startTime: 2, endTime: 7, text: 'legacy' });
  });

  it('synthesises timings for untimed USLT text', async () => {
    const payload = usltPayload(3, [0], utf8Bytes('plain one\nplain two'));
    const tag = id3Tag(id3Frame('USLT', payload, 3), 3);
    const data = (await extractEmbeddedLyrics(bytesToFile(tag, 'song.mp3'))) as LyricsData;

    expect(data.lines).toEqual([
      { startTime: 0, endTime: 2, text: 'plain one' },
      { startTime: 2, endTime: 4, text: 'plain two' },
    ]);
  });

  it('reads an ID3v2 tag from a WAV `id3 ` chunk', async () => {
    const tag = id3Tag(id3Frame('USLT', usltPayload(3, [0], utf8Bytes('[00:01.00]wav')), 3), 3);
    const data = (await extractEmbeddedLyrics(bytesToFile(wavWithId3Chunk(tag), 'song.wav'))) as LyricsData;

    expect(data.lines[0]).toEqual({ startTime: 1, endTime: 6, text: 'wav' });
  });

  it('returns null when a tag carries no lyric frames', async () => {
    const tag = id3Tag(id3Frame('TIT2', concat([3], utf8Bytes('Title only')), 3), 3);
    expect(await extractEmbeddedLyrics(bytesToFile(tag, 'song.mp3'))).toBeNull();
  });

  it('returns null for empty, truncated, random and non-audio payloads', async () => {
    expect(await extractEmbeddedLyrics(bytesToFile([], 'empty.mp3'))).toBeNull();
    expect(await extractEmbeddedLyrics(bytesToFile([0x49, 0x44, 0x33], 'tiny.mp3'))).toBeNull();
    expect(await extractEmbeddedLyrics(bytesToFile(zeros(64), 'zeros.mp3'))).toBeNull();

    const valid = mp3WithUslt('[00:01.00]hello', 3, 3);
    const truncated = valid.slice(0, Math.floor(valid.length * 0.6));
    expect(await extractEmbeddedLyrics(bytesToFile(truncated, 'cut.mp3'))).toBeNull();

    const random = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    expect(await extractEmbeddedLyrics(bytesToFile(random, 'random.bin'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Embedded tags: MP4 / FLAC / OGG
// ---------------------------------------------------------------------------

describe('extractEmbeddedLyrics — MP4, FLAC and OGG', () => {
  it('walks moov/udta/meta/ilst/©lyr and handles a 64-bit box size', async () => {
    const data = (await extractEmbeddedLyrics(bytesToFile(mp4WithLyrics('[00:01.00]mp4 line'), 'song.m4a'))) as LyricsData;

    expect(data).not.toBeNull();
    expect(data.lines[0]).toEqual({ startTime: 1, endTime: 6, text: 'mp4 line' });
  });

  it('returns null for an MP4 without a ©lyr atom', async () => {
    const ilst = mp4Box('ilst', mp4Box('\u00a9nam', mp4Box('data', concat(u32be(1), u32be(0), utf8Bytes('Title')))));
    const meta = mp4Box('meta', concat(zeros(4), ilst));
    const ftyp = mp4Box('ftyp', concat(latin1Bytes('M4A '), u32be(0), latin1Bytes('M4A '), latin1Bytes('mp42')));
    const file = concat(ftyp, mp4Box('moov', mp4Box('udta', meta)));

    expect(await extractEmbeddedLyrics(bytesToFile(file, 'song.m4a'))).toBeNull();
  });

  it('reads FLAC Vorbis LYRICS= comments', async () => {
    const file = flacWithVorbisComments([
      ['TITLE', 'Song'],
      ['LYRICS', '[00:02.00]flac line'],
    ]);
    const data = (await extractEmbeddedLyrics(bytesToFile(file, 'song.flac'))) as LyricsData;

    expect(data.lines[0]).toEqual({ startTime: 2, endTime: 7, text: 'flac line' });
  });

  it('reads OGG Vorbis UNSYNCEDLYRICS= comments', async () => {
    const file = oggVorbisWith([['UNSYNCEDLYRICS', '[00:03.00]ogg line']]);
    const data = (await extractEmbeddedLyrics(bytesToFile(file, 'song.ogg'))) as LyricsData;

    expect(data.lines[0]).toEqual({ startTime: 3, endTime: 8, text: 'ogg line' });
  });

  it('reads OpusTags lyrics and ignores comment sets with no lyric key', async () => {
    const opus = oggOpusWith([['LYRICS', '[00:04.00]opus line']]);
    const opusData = (await extractEmbeddedLyrics(bytesToFile(opus, 'song.opus'))) as LyricsData;
    expect(opusData.lines[0].text).toBe('opus line');

    const noLyrics = oggVorbisWith([['ARTIST', 'Someone'], ['TITLE', 'Song']]);
    expect(await extractEmbeddedLyrics(bytesToFile(noLyrics, 'song.ogg'))).toBeNull();
    expect(await extractEmbeddedLyrics(bytesToFile(flacWithVorbisComments([['TITLE', 'Song']]), 'song.flac'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveLocalLyrics
// ---------------------------------------------------------------------------

describe('credit lines', () => {
  it('drops LRC credit lines and keeps the first real lyric at its own time', () => {
    const lrc = [
      '[ar:Someone]',
      '[ti:Song]',
      '[00:00.00]Lyrics by: Someone',
      '[00:00.00]\u4f5c\u8bcd : TOKOTOKO',
      '[00:00.15]\u4f5c\u66f2 : TOKOTOKO',
      '[00:00.31]first line',
    ].join('\n');

    const data = parseLrc(lrc);
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].startTime).toBeCloseTo(0.31, 3);
    expect(data.lines[0].text).toBe('first line');
  });

  it('drops credit cues in SRT subtitles', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:01,000',
      'Composer: Someone',
      '',
      '2',
      '00:00:02,000 --> 00:00:04,000',
      'real line',
    ].join('\n');

    expect(parseSrt(srt).lines).toEqual([{ startTime: 2, endTime: 4, text: 'real line' }]);
  });

  it('drops credits from untimed text without renumbering the remaining lines', () => {
    const text = ['\u4f5c\u8bcd\uff1aX', 'line one', '\u4f5c\u66f2\uff1aY', 'line two'].join('\n');
    const data = parsePlainLyrics(text);

    expect(data.lines.map((line) => line.text)).toEqual(['line one', 'line two']);
    expect(data.lines[0].startTime).toBe(2);
    expect(data.lines[1].startTime).toBe(6);
  });

  it('keeps a lyric that only mentions a credit word mid-line', () => {
    const lrc = '[00:01.00]\u3053\u306e\u66f2\u306f\u6700\u9ad8';
    expect(parseLrc(lrc).lines[0].text).toBe('\u3053\u306e\u66f2\u306f\u6700\u9ad8');
  });

  it('strips credit lines from lyrics that were parsed before the filter existed', () => {
    const lines = [
      { startTime: 0, endTime: 0.15, text: '\u4f5c\u8bcd : X' },
      { startTime: 0.31, endTime: 1.16, text: 'real line' },
    ];

    expect(dropCreditLines(lines)).toEqual([{ startTime: 0.31, endTime: 1.16, text: 'real line' }]);
  });
});

describe('resolveLocalLyrics', () => {
  it('prefers the uploaded lyrics file over embedded tags', async () => {
    const audio = bytesToFile(mp3WithUslt('[00:09.00]embedded', 3, 3), 'song.mp3');
    const lyricsFile = textToFile('[00:01.00]uploaded', 'song.lrc');

    const resolved = await resolveLocalLyrics(audio, lyricsFile);
    expect(resolved?.source).toBe('lyrics-file');
    expect(resolved?.data.lines[0]).toEqual({ startTime: 1, endTime: 6, text: 'uploaded' });
  });

  it('falls back to embedded tags, including when the uploaded file has no lines', async () => {
    const audio = bytesToFile(mp3WithUslt('[00:09.00]embedded', 3, 3), 'song.mp3');

    const fromTags = await resolveLocalLyrics(audio, null);
    expect(fromTags?.source).toBe('embedded');
    expect(fromTags?.data.lines[0].text).toBe('embedded');

    const withEmptyUpload = await resolveLocalLyrics(audio, textToFile('   ', 'empty.lrc'));
    expect(withEmptyUpload?.source).toBe('embedded');
  });

  it('returns null when neither source has lyrics', async () => {
    const audio = bytesToFile(id3Tag(id3Frame('TIT2', concat([3], utf8Bytes('Title')), 3), 3), 'song.mp3');
    expect(await resolveLocalLyrics(audio, null)).toBeNull();
    expect(await resolveLocalLyrics(audio, textToFile('   \n ', 'blank.txt'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bilingual pairs (original + translation on the same line)
// ---------------------------------------------------------------------------

describe('bilingual pairs', () => {
  // "\u3053\u3093\u306b\u3061\u306f" (Japanese) and "\u4f60\u597d\u4e16\u754c" (Chinese)
  // are written as escapes so this source file stays ASCII.
  const japanese = '\u3053\u3093\u306b\u3061\u306f';
  const chinese = '\u4f60\u597d\u4e16\u754c';

  it('folds a same-timestamp original/translation pair into one line', () => {
    const lrc = [
      '[00:00.31]' + japanese,
      '[00:00.31]' + chinese,
      '[00:01.16]second',
    ].join('\n');

    const data = parseLrc(lrc);
    expect(data.lines).toHaveLength(2);
    expect(data.lines[0].text).toBe(japanese);
    expect(data.lines[0].translation).toBe(chinese);
    expect(data.lines[0].translationLanguage).toBe('zh');
    expect(data.lines[0].startTime).toBeCloseTo(0.31, 3);
    expect(data.lines[0].endTime).toBeCloseTo(1.16, 3);
    expect(data.lines[1].text).toBe('second');
  });

  it('keeps the file-majority language as the sung text', () => {
    const lrc = [
      '[00:00.00]' + chinese,
      '[00:00.00]hello world',
      '[00:02.00]we sing in english here',
      '[00:04.00]and the rest of this file is latin',
    ].join('\n');

    const data = parseLrc(lrc);
    expect(data.lines[0].text).toBe('hello world');
    expect(data.lines[0].translation).toBe(chinese);
    expect(data.lines[0].translationLanguage).toBe('zh');
  });

  it('ignores an untimed line so monolingual files are never guessed into translations', () => {
    const lrc = ['[00:00.31]' + japanese, chinese, '[00:01.16]next'].join('\n');

    const data = parseLrc(lrc);
    expect(data.lines).toHaveLength(2);
    expect(data.lines[0].text).toBe(japanese);
    expect(data.lines[0].translation).toBeUndefined();
  });

  it('leaves monolingual lines alone when they share a timestamp and a script', () => {
    const lrc = ['[00:01.00]same script one', '[00:01.00]same script two'].join('\n');

    const data = parseLrc(lrc);
    expect(data.lines).toHaveLength(2);
    expect(data.lines.every((line) => line.translation === undefined)).toBe(true);
  });

  it('does not split a monolingual line that happens to contain a bar', () => {
    const data = parseLrc('[00:01.00]la la | la la');

    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].text).toBe('la la | la la');
  });

  it('splits an explicit separator into one line with a translation', () => {
    const lrc = '[00:00.31]' + japanese + ' | ' + chinese;

    const data = parseLrc(lrc);
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].text).toBe(japanese);
    expect(data.lines[0].translation).toBe(chinese);
  });

  it('splits a bilingual SRT cue into one line with a translation', () => {
    const srt = ['1', '00:00:00,310 --> 00:00:01,160', japanese, chinese].join('\n');

    const data = parseSrt(srt);
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].text).toBe(japanese);
    expect(data.lines[0].translation).toBe(chinese);
  });

  it('leaves two lines in the same script alone', () => {
    const lrc = ['[00:00.31]first line', '[00:00.31]second line'].join('\n');

    expect(parseLrc(lrc).lines).toHaveLength(2);
  });

  it('leaves already merged lines untouched', () => {
    const lines = [{
      startTime: 0.31,
      endTime: 1.16,
      text: japanese,
      translation: chinese,
      translationLanguage: 'zh',
    }];

    expect(mergeBilingualLines(lines)).toEqual(lines);
  });

  it('migrates a legacy two-line pair from the lyrics cache', () => {
    const legacy = [
      { startTime: 0.31, endTime: 0.56, text: japanese },
      { startTime: 0.31, endTime: 1.16, text: chinese },
    ];

    const merged = mergeBilingualLines(legacy);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe(japanese);
    expect(merged[0].translation).toBe(chinese);
    expect(merged[0].endTime).toBeCloseTo(1.16, 3);
  });
});