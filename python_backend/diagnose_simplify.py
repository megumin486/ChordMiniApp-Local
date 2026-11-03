"""Diagnose the simplify bug: why chords turn into N.C.

Simulates the frontend call chain:
  backend analyze-harmony returns sequenceCorrections
  -> frontend buildLegacyCorrections builds the corrections map by index
  -> the simplify button triggers simplifyChordCorrections
"""
import json

from services.harmony.chord_normalizer import normalize_chord
from services.harmony.enharmonic import correct_sequence

# chord sequence of the real test audio (with N.C. placeholders)
CHORDS = ["N", "Eb:maj", "G:7", "C:min7", "Ab:min", "G:min", "C:min", "F:min7",
          "Bb:maj", "Eb:maj", "G:maj", "C:min", "Ab:min", "G:min", "C:min"]

print("=" * 70)
print("1. Raw input")
print("=" * 70)
print(CHORDS[:8])

print()
print("=" * 70)
print("2. normalize results (None means no chord)")
print("=" * 70)
normalized = [normalize_chord(c) for c in CHORDS]
for src, n in zip(CHORDS, normalized):
    print(f"  {src:12s} -> {n}")

valid = [c for c in normalized if c]
print(f"\nValid chords: {len(valid)} / total {len(normalized)}")

print()
print("=" * 70)
print("3. correct_sequence (what the backend calls today)")
print("=" * 70)
corr = correct_sequence(valid, "Eb major")
print(f"  originalSequence length: {len(corr['originalSequence'])}")
print(f"  correctedSequence length: {len(corr['correctedSequence'])}")
print(f"  first 6 corrected: {corr['correctedSequence'][:6]}")

print()
print("=" * 70)
print("4. Simulating the fixed alignment logic")
print("=" * 70)
original_seq = [c if c is not None else "N.C." for c in normalized]
corrected_full = []
corr_iter = iter(corr["correctedSequence"])
for c in normalized:
    if c is None:
        corrected_full.append("N.C.")
    else:
        try:
            corrected_full.append(next(corr_iter))
        except StopIteration:
            corrected_full.append(c)

print(f"  originalSequence length:  {len(original_seq)}")
print(f"  correctedSequence length: {len(corrected_full)}")
print(f"  lengths match: {len(original_seq) == len(corrected_full)}")
print()
for i, (o, c) in enumerate(zip(original_seq, corrected_full)):
    mark = "  " if o == c else "->"
    print(f"  [{i:2d}] {o:12s} {mark} {c}")

print()
print("=" * 70)
print("5. Simulating the frontend buildLegacyCorrections")
print("=" * 70)
legacy = {}
for i, o in enumerate(original_seq):
    c = corrected_full[i]
    if o != c:
        legacy[o] = c
print(f"  corrections map: {legacy}")
print()
print("  Note: if 'N.C.' appears as a map key, simplification passes every N.C. to simplifyChord")
print(f"  is 'N.C.' in the map: {'N.C.' in legacy}")
