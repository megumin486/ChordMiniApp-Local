"""Chord spelling correction (enharmonic correction).

Corresponds to item 15 of FEATURE_SCOPE. Strategy:
  1. the key decides the sharp/flat preference (flat keys take flats, sharp keys take sharps)
  2. use harte-library's prettify to pick the most concise spelling
  3. keep one consistent accidental system across the song (avoid one stretch of F# and another of Gb)
"""
from __future__ import annotations

from typing import Optional

from services.harmony.chord_normalizer import normalize_chord

NOTE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# keys conventionally written with flats
FLAT_KEY_TONICS = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb", "D", "G", "C",
                   "Bb", "Eb", "Ab", "Db"}


def _pc_of(name: str) -> Optional[int]:
    n = name.strip()
    if not n or n[0] not in NOTE_PC:
        return None
    pc = NOTE_PC[n[0]]
    for ch in n[1:]:
        if ch == "#":
            pc += 1
        elif ch == "b":
            pc -= 1
        else:
            break
    return pc % 12


def key_preference(key_str: str) -> str:
    """Decide whether this key prefers sharps or flats.

    music21's Key.sharps is the authoritative criterion:
      sharps < 0 -> flat (flat key)
      sharps > 0 -> sharp (sharp key)
      sharps == 0 -> neutral (C major / A minor)
    """
    try:
        from music21 import key as m21key
        parts = key_str.split()
        tonic = parts[0] if parts else "C"
        mode = parts[1] if len(parts) > 1 else "major"
        k = m21key.Key(tonic, mode)
        sharps = k.sharps
        if sharps < 0:
            return "flat"
        if sharps > 0:
            return "sharp"
        return "neutral"
    except Exception:
        # fallback: decide from the string
        tonic = key_str.split()[0] if key_str else "C"
        if "b" in tonic:
            return "flat"
        if "#" in tonic:
            return "sharp"
        return "neutral"


def spell_root(pc: int, preference: str) -> str:
    if preference == "flat":
        return FLAT_NAMES[pc]
    if preference == "sharp":
        return SHARP_NAMES[pc]
    # neutral: natural notes such as C, E, G are used as-is; altered notes follow common convention
    if FLAT_NAMES[pc] == SHARP_NAMES[pc]:
        return SHARP_NAMES[pc]
    NEUTRAL = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    return NEUTRAL[pc]


def correct_chord(chord: str, key_str: str) -> str:
    """Correct the spelling of a single chord."""
    normalized = normalize_chord(chord)
    if normalized is None:
        return chord

    pref = key_preference(key_str)
    root, _, rest = normalized.partition(":")
    root_pc = _pc_of(root)
    if root_pc is None:
        return chord

    new_root = spell_root(root_pc, pref)

    # handle the bass after the slash
    quality, sep, slash = rest.partition("/")
    if sep and slash:
        # the slash may be a numeric inversion (/3, /5) or a note (/F#)
        if slash.isdigit():
            new_slash = slash
        else:
            bass_pc = _pc_of(slash)
            new_slash = spell_root(bass_pc, pref) if bass_pc is not None else slash
        rest = f"{quality}/{new_slash}"

    return f"{new_root}:{quality}" if not sep else f"{new_root}:{quality}/{rest.partition('/')[2]}"


def correct_sequence(chord_names: list[str], key_str: str) -> dict:
    """Correct a whole sequence; returns originalSequence / correctedSequence / corrections.

    Keeps one accidental system across the song, decided by key_preference.
    """
    original = []
    corrected = []
    corrections = {}

    for name in chord_names:
        normalized = normalize_chord(name)
        if normalized is None:
            # no-chord positions are kept as they are
            original.append(name)
            corrected.append(name)
            continue
        fixed = correct_chord(normalized, key_str)
        original.append(normalized)
        corrected.append(fixed)
        if normalized != fixed:
            corrections[normalized] = fixed

    return {
        "originalSequence": original,
        "correctedSequence": corrected,
        "corrections": corrections,
    }
