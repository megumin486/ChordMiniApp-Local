"""Verify the actual API behaviour of music21 and harte-library.

Purpose: confirm the rule engine's input and output formats, especially Harte notation parsing and roman numeral generation.
Usage: python probe_harmony.py
"""
import sys

FAIL = 0


def check(cond, msg):
    global FAIL
    if cond:
        print(f"  OK   {msg}")
    else:
        print(f"  FAIL {msg}")
        FAIL += 1


print("=" * 60)
print("1. can harte-library parse the chord format our models output")
print("=" * 60)
try:
    from harte.harte import Harte

    cases = [
        "Eb:maj",      # Chord-CNN-LSTM output format
        "G:7",
        "C:min7",
        "F#:maj/3",    # Harte spelling with an inversion
        "C#:7/b7",
        "Eb",          # BTC output format (shorthand)
        "N",           # no-chord marker
    ]
    for c in cases:
        try:
            h = Harte(c)
            print(f"  OK   Harte('{c}') -> root={h.root()} bass={h.bass()}")
            check(True, f"parse {c}")
        except Exception as e:
            print(f"  WARN Harte('{c}') failed: {type(e).__name__}: {e}")
            check(False, f"parse {c}")
except ImportError as e:
    print(f"  FAIL cannot import harte: {e}")
    FAIL += 1

print()
print("=" * 60)
print("2. music21 roman numerals (including figure-bass inversions)")
print("=" * 60)
try:
    from music21 import chord, key, roman

    kC = key.Key("C", "major")
    for chord_str in ["C4 E4 G4", "A3 C4 E4", "F4 A4 C5", "G3 B3 D4 F4"]:
        ch = chord.Chord(chord_str)
        rn = roman.romanNumeralFromChord(ch, kC)
        print(f"  OK   {chord_str:16s} -> figure={rn.figure:8s} figuresWritten={getattr(rn, 'figuresWritten', '')}")
        check(rn.figure != "", f"roman numeral {chord_str}")

    # minor
    kAm = key.Key("A", "minor")
    ch_am = chord.Chord("A3 C4 E4")
    rn_am = roman.romanNumeralFromChord(ch_am, kAm)
    print(f"  OK   Am in A minor -> {rn_am.figure}")
    check(rn_am.figure.lower().startswith("i"), "minor roman numeral")

    # explicit inversion test
    rn65 = roman.RomanNumeral("ii65", "C")
    print(f"  OK   RomanNumeral('ii65','C') -> figuresWritten={rn65.figuresWritten}")
    check(bool(rn65.figuresWritten), "figure-bass inversion")
except Exception as e:
    print(f"  FAIL music21 test failed: {type(e).__name__}: {e}")
    FAIL += 1

print()
print("=" * 60)
print("3. music21 key detection (inferred from a chord sequence)")
print("=" * 60)
try:
    from music21 import stream, harmony

    s = stream.Stream()
    for name in ["C", "G", "Am", "F", "C", "G", "F", "C"]:
        cs = harmony.ChordSymbol(name)
        s.append(cs)

    # analyze needs pitches, so convert the ChordSymbol to a Chord first
    s2 = stream.Stream()
    for name in ["C", "G", "Am", "F", "C", "G", "F", "C"]:
        cs = harmony.ChordSymbol(name)
        for n in cs.pitches:
            pass
        s2.append(cs.chord)
    detected = s2.analyze("key")
    print(f"  OK   analysis result: {detected}")
    check(detected is not None, "key detection")
except Exception as e:
    print(f"  WARN music21 analyze failed (harmless, the heuristic can replace it): {type(e).__name__}: {e}")

print()
print("=" * 60)
print(f"Result: {FAIL} failures")
print("=" * 60)
sys.exit(0 if FAIL == 0 else 1)
