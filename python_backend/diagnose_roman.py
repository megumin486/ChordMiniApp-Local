"""Verify the degree mapping in C minor precisely.

Diagnose why Ab:min outputs vi instead of bVI.
"""
import sys

from music21 import pitch

from services.harmony.roman_analyzer import _degree_of, chord_to_roman, make_key_object

print("C minor degree offsets:", [0, 2, 3, 5, 7, 8, 10])
print("(matching pc: C=0, D=2, Eb=3, F=5, G=7, Ab=8, Bb=10)")
print()

key = make_key_object("C minor")
key_pc = key.tonic.pitchClass
print(f"C minor tonic pc = {key_pc}")
print()

chords = ["C:min", "Eb:maj", "G:7", "G:min", "Ab:maj", "Ab:min", "Bb:maj", "F:min7", "D:min", "A:min"]
print(f"{'chord':12s} {'pc':>4s} {'diff':>5s} {'degree':>4s} {'delta':>6s} {'roman':>8s}")
print("-" * 50)
for c in chords:
    root = c.partition(":")[0]
    pc = pitch.Pitch(root).pitchClass
    diff = (pc - key_pc) % 12
    degree, delta = _degree_of(pc, key_pc, "minor")
    rn = chord_to_roman(c, key)
    print(f"{c:12s} {pc:4d} {diff:5d} {degree:4d} {delta:6d} {str(rn):>8s}")

print()
print("=" * 60)
print("Key check: Ab (pc=8) in C minor")
print("=" * 60)
pc_ab = pitch.Pitch("Ab").pitchClass
degree, delta = _degree_of(pc_ab, 0, "minor")
print(f"Ab pc={pc_ab}, diff={pc_ab % 12}")
print(f"_degree_of returns: degree={degree}, delta={delta}")
if delta != 0:
    print(f"  -> should output b{'I'*0}{'VI' if degree == 6 else ''}: accidental=b, symbol=VI")
else:
    print(f"  -> delta=0 was mistaken for in-key! symbol = {['i','ii','iii','iv','v','vi','vii'][degree-1]}")
    print("   BUG: Ab's pc=8 collides with degree 6's offset of 8 in C minor")

print()
print("Note: the sixth degree of the C natural minor scale is A (pc=9), not Ab (pc=8).")
print("      but degree 6's offset is written as 8 in MINOR_OFFSETS,")
print("      which makes Ab (pc=8) look like it lands exactly on degree 6!")
print()
print("Check: the offsets of the natural minor scale C-D-Eb-F-G-Ab-Bb should be")
print("      0, 2, 3, 5, 7, 8(A b), 10")
print("      wait -- the sixth degree of C natural minor really is Ab (pc=8), not A!")
print()
print("Re-checking C natural minor:")
print("  1=C(0) 2=D(2) 3=Eb(3) 4=F(5) 5=G(7) 6=Ab(8) 7=Bb(10)")
print("  so Ab in C minor really is degree VI and outputting vi is correct!")
print()
sys.exit(0)
