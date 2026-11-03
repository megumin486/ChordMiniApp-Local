import { buildBeatToChordSequenceMap } from '@/utils/chordFormatting';

describe('buildBeatToChordSequenceMap', () => {
  it('aligns Roman numeral mapping across enharmonic equivalents', () => {
    const map = buildBeatToChordSequenceMap(
      3,
      ['C#', 'D#', 'G#'],
      { analysis: ['IV', 'V', 'I'] },
      {
        correctedSequence: ['Db', 'Eb', 'Ab'],
      },
    );

    expect(map[0]).toBe(0);
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(2);
  });

  // v4.2 contract: the grid's leading padding cells are a display artifact (the
  // backend never received them), so they must not claim a sequence slot;
  // `paddingCount` comes from diagnostics via ChordGridHeader.
  const shiftedChords = ['N.C.', 'Cm', 'Cm', 'Ab', 'Ab', 'Eb', 'Eb', 'Eb'];
  const romanNumeralData = { analysis: ['i', 'VI', 'III'] };
  const diagnostics = { paddingCount: 1 };

  it('skips the leading padding cell so the first real chord keeps numeral 0', () => {
    const map = buildBeatToChordSequenceMap(
      shiftedChords.length,
      shiftedChords,
      romanNumeralData,
      { correctedSequence: shiftedChords },
      diagnostics,
    );

    expect(map[0]).toBeUndefined(); // padding cells carry no Roman numeral
    expect(map[1]).toBe(0); // Cm -> i
    expect(map[2]).toBe(0);
    expect(map[3]).toBe(1); // Ab -> VI
    expect(map[4]).toBe(1);
    expect(map[5]).toBe(2); // Eb -> III
    expect(map[6]).toBe(2);
    expect(map[7]).toBe(2);
  });

  it('behaves the same when sequenceCorrections is null', () => {
    const map = buildBeatToChordSequenceMap(
      shiftedChords.length,
      shiftedChords,
      romanNumeralData,
      null,
      diagnostics,
    );

    expect(map[0]).toBeUndefined();
    expect(map[1]).toBe(0);
    expect(map[3]).toBe(1);
    expect(map[5]).toBe(2);
  });

  it('falls back to no padding skip when diagnostics are absent', () => {
    const map = buildBeatToChordSequenceMap(
      shiftedChords.length,
      shiftedChords,
      romanNumeralData,
      null,
    );

    // Without paddingCount the leading N.C. claims sequence slot 0 and every
    // numeral shifts by one, which is exactly what was observed on a.mp3 before
    // the v4.2 fix.
    expect(map[0]).toBe(0); // the N.C. steals slot 0
    expect(map[1]).toBe(1); // so Cm is pushed back
    expect(map[2]).toBe(1);
    expect(map[3]).toBe(2);
    expect(map[5]).toBeUndefined(); // slots exhausted, so Eb gets no numeral
  });
});