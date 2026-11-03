"""Roman numeral analysis: deterministic degree detection + concise notation.

Corresponds to item 13 of FEATURE_SCOPE. No LLM is used.

Design decisions (confirmed by the user on 2026-10-31):
  - out-of-key chords do not stack chromatic marks; we output "main degree + quality suffix" (e.g. III7)
  - diatonic vs. out-of-key is decided by deterministic degree + quality matching, not by music21's functionalityScore
    (measured: that score is unreliable for seventh chords -- Cm7 in Eb major is scored 0)
"""
from __future__ import annotations

from typing import Optional

from music21 import key as m21key
from music21 import pitch as m21pitch

from services.harmony.chord_normalizer import normalize_chord

MAJOR_ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"]
MINOR_ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii"]

# interval offsets of the natural major degrees (semitones relative to the tonic)
MAJOR_OFFSETS = [0, 2, 4, 5, 7, 9, 11]
# natural minor
MINOR_OFFSETS = [0, 2, 3, 5, 7, 8, 10]

# natural triad quality of each degree
MAJOR_QUALITIES = ["maj", "min", "min", "maj", "maj", "min", "dim"]
MINOR_QUALITIES = ["min", "dim", "maj", "min", "min", "maj", "maj"]
# minor allows a major triad on the dominant (the raised leading tone of harmonic minor)
MINOR_ALLOW_MAJOR_ON = {5}

# quality -> triad family
QUALITY_FAMILY = {
    "maj": "maj", "maj7": "maj", "6": "maj",
    "7": "maj",
    "min": "min", "min7": "min", "min6": "min",
    "dim": "dim", "dim7": "dim", "hdim7": "dim",
    "aug": "other", "sus": "other", "sus4": "other",
}

# quality -> roman numeral suffix
QUALITY_SUFFIX = {
    "maj": "",
    "maj7": "maj7",
    "min": "",
    "min7": "7",
    "min6": "6",
    "7": "7",
    "dim": "°",
    "dim7": "°7",
    "hdim7": "ø7",
    "aug": "+",
    "sus4": "sus4",
    "sus": "sus4",
    "6": "6",
}

# inversion figures: plain triads / seventh chords
INVERSION_TRIAD = {"3": "6", "5": "64"}
INVERSION_SEVENTH = {"3": "65", "5": "43", "7": "42"}

# seventh-chord qualities: on inversion the figured-bass figure replaces the quality suffix
SEVENTH_QUALITIES = {"7", "maj7", "min7", "dim7", "hdim7"}


def make_key_object(key_str: str):
    parts = key_str.split()
    tonic = parts[0] if parts else "C"
    mode = parts[1] if len(parts) > 1 else "major"
    return m21key.Key(tonic, mode)


def _pc_of(name: str) -> Optional[int]:
    try:
        return m21pitch.Pitch(name).pitchClass
    except Exception:
        return None


def _degree_of(root_pc: int, key_pc: int, mode: str) -> tuple[int, int]:
    """Return (degree, semitone deviation relative to that degree).

    The degree is 1-7; a deviation of 0 means it lands exactly on an in-key degree.
    """
    offsets = MINOR_OFFSETS if mode == "minor" else MAJOR_OFFSETS
    diff = (root_pc - key_pc) % 12

    for i, off in enumerate(offsets):
        if diff == off:
            return i + 1, 0

    best = None
    for i, off in enumerate(offsets):
        delta = (diff - off + 6) % 12 - 6
        if best is None or abs(delta) < abs(best[1]):
            best = (i + 1, delta)
    return best if best else (1, diff)


# semitone offset -> (degree, accidental): the **conventional spelling** for out-of-key chords
#
# Why we do not build the accidental from _degree_of's "nearest degree": the nearest degree only guarantees the right pitch,
# and the spelling is often unconventional. Measured (A major): Bb comes out as #I, C as #II, and F, sitting exactly between E and F#,
# becomes #vø7 -- every pitch is right, but any musician reads these as bII / bIII / bVI.
# This fixed table gives the spellings standard in the literature:
#   offset 1 -> bII (Neapolitan), 3 -> bIII, 6 -> #IV, 8 -> bVI, 10 -> bVII.
# The table works for both modes: the natural degrees of minor are already bIII/bVI/bVII, and raising them is written III/vii
# (the harmonic-minor convention), so they never collide with the natural degrees.
_DEGREE_SPELLING: dict[int, tuple[int, str]] = {
    0: (1, ""),
    1: (2, "b"),
    2: (2, ""),
    3: (3, "b"),
    4: (3, ""),
    5: (4, ""),
    6: (4, "#"),
    7: (5, ""),
    8: (6, "b"),
    9: (6, ""),
    10: (7, "b"),
    11: (7, ""),
}


def _degree_and_accidental(root_pc: int, key_pc: int) -> tuple[int, str]:
    """Return (degree, accidental string); used only to display out-of-key degrees.

    Deciding "whether it is diatonic" still goes through _degree_of (only deviation 0 counts as diatonic); this function only handles spelling.
    """
    diff = (root_pc - key_pc) % 12
    return _DEGREE_SPELLING[diff]


def is_diatonic(root_pc: int, quality: str, key_pc: int, mode: str) -> bool:
    """Deterministic test: whether the chord belongs entirely to that key.

    Rule: the degree is in key and the quality matches the natural triad of that degree.
    """
    degree, delta = _degree_of(root_pc, key_pc, mode)
    if delta != 0:
        return False

    family = QUALITY_FAMILY.get(quality, "other")
    if family == "other":
        return False

    expected = (MINOR_QUALITIES if mode == "minor" else MAJOR_QUALITIES)[degree - 1]

    if family == expected:
        return True
    # the V degree of minor allows a major triad (harmonic minor)
    if mode == "minor" and degree in MINOR_ALLOW_MAJOR_ON and family == "maj":
        return True
    # seventh chords in major: the triad part of V7/VII7 is maj, already covered above
    return False


def chord_to_roman(harte_or_simple: str, key_obj) -> Optional[str]:
    """Single chord -> concise roman numeral."""
    normalized = normalize_chord(harte_or_simple)
    if normalized is None:
        return None

    root, _, rest = normalized.partition(":")
    quality, sep, slash = rest.partition("/")

    root_pc = _pc_of(root)
    if root_pc is None:
        return None

    key_pc = key_obj.tonic.pitchClass
    mode = key_obj.mode
    degree, accidental = _degree_and_accidental(root_pc, key_pc)

    table = MINOR_ROMAN if mode == "minor" else MAJOR_ROMAN
    symbol = table[degree - 1]

    family = QUALITY_FAMILY.get(quality, "other")
    if family in ("min", "dim"):
        symbol = symbol.lower()
    else:
        symbol = symbol.upper()

    suffix = QUALITY_SUFFIX.get(quality, "")

    # the out-of-key mark (#IV, bII, ...) already comes from _degree_and_accidental in its conventional spelling

    # inversion figure
    figure = ""
    if slash and (slash in INVERSION_TRIAD or slash in INVERSION_SEVENTH):
        if quality in SEVENTH_QUALITIES:
            # seventh-chord inversion: the figured-bass figure (65/43/42) already carries the seventh,
            # so we must not append the quality suffix too, or we would spell garbage such as III743
            inv_map = INVERSION_SEVENTH
            suffix = ""
        else:
            inv_map = INVERSION_TRIAD
        figure = inv_map.get(slash, "")

    return f"{accidental}{symbol}{suffix}{figure}"


def analyze_sequence(chord_names: list[str], key_str: str) -> list[Optional[str]]:
    """Whole sequence -> list of roman numerals."""
    key_obj = make_key_object(key_str)
    return [chord_to_roman(name, key_obj) for name in chord_names]


def analyze_sequence_with_scores(chord_names: list[str], key_str: str) -> list[dict]:
    """Analysis that also reports diatonic status, so the frontend can flag out-of-key chords."""
    key_obj = make_key_object(key_str)
    key_pc = key_obj.tonic.pitchClass
    mode = key_obj.mode

    results = []
    for name in chord_names:
        normalized = normalize_chord(name)
        rn = chord_to_roman(name, key_obj)

        diatonic = False
        if normalized:
            root, _, rest = normalized.partition(":")
            quality = rest.partition("/")[0]
            root_pc = _pc_of(root)
            if root_pc is not None:
                diatonic = is_diatonic(root_pc, quality, key_pc, mode)

        results.append({
            "roman": rn,
            "is_out_of_key": not diatonic,
        })
    return results


def build_key_context(key_str: str) -> str:
    return key_str
