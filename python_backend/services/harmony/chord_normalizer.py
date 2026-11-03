"""Chord format normalization layer.

The two model outputs use different formats:
  - Chord-CNN-LSTM: Harte notation, e.g. "Eb:maj", "G:7", "C:min7"
  - BTC-SL / BTC-PL: shorthand, e.g. "Eb", "G", "C:maj"

Everything is normalized to Harte notation so harte-library and music21 can process it.
"""
from __future__ import annotations

from typing import Optional

# the various spellings of the no-chord marker
NO_CHORD_TOKENS = {"N", "N/C", "N.C.", "NC", "", "None", "none"}

# shorthand suffix -> Harte quality
SIMPLE_QUALITY_MAP = {
    "": "maj",
    "maj": "maj",
    "min": "min",
    "m": "min",
    "min7": "min7",
    "m7": "min7",
    "7": "7",
    "dim": "dim",
    "aug": "aug",
    "sus": "sus4",
    "sus4": "sus4",
    "dim7": "dim7",
    "hdim7": "hdim7",
    "min6": "min6",
    "maj7": "maj7",
    "6": "6",
}

# Harte quality -> plain chord-name suffix (for music21 ChordSymbol parsing)
PLAIN_QUALITY_MAP = {
    "maj": "",
    "min": "m",
    "min7": "m7",
    "maj7": "maj7",
    "dim": "dim",
    "dim7": "dim7",
    "hdim7": "m7b5",
    "aug": "aug",
    "sus4": "sus4",
    "sus": "sus4",
    "7": "7",
    "6": "6",
}


def is_no_chord(token: str) -> bool:
    """Return whether the token is the no-chord marker."""
    return token.strip() in NO_CHORD_TOKENS


def normalize_chord(token: str) -> Optional[str]:
    """Normalize any model output into Harte notation.

    Returning None means there is no chord at this position; the caller should skip it or use a placeholder.

    >>> normalize_chord("Eb:maj")
    'Eb:maj'
    >>> normalize_chord("Eb")
    'Eb:maj'
    >>> normalize_chord("C:m7")
    'C:min7'
    >>> normalize_chord("N")
    """
    if not token:
        return None
    raw = token.strip()
    if is_no_chord(raw):
        return None

    # a token already containing a colon is treated as Harte, but its quality name is normalized
    if ":" in raw:
        root_part, _, rest = raw.partition(":")
        # split off a possible slash suffix (such as /3 or /b7)
        quality, sep, slash = rest.partition("/")
        quality_norm = SIMPLE_QUALITY_MAP.get(quality.lower(), quality)
        return f"{root_part}:{quality_norm}{sep}{slash}"

    # no colon: could be shorthand ("Eb", "Am", "G7") or carry a slash ("D/F#")
    root, sep, bass = raw.partition("/")
    # separate the root from the quality suffix
    root_note, quality = _split_root_quality(root)
    quality_norm = SIMPLE_QUALITY_MAP.get(quality.lower(), quality)
    out = f"{root_note}:{quality_norm}"
    if sep:
        # in shorthand the slash marks a real note (D/F#); convert it to Harte's slash-note form
        out = f"{out}/{bass}"
    return out


def _split_root_quality(token: str) -> tuple[str, str]:
    """Split "Am7" into ("A", "m7") and "C" into ("C", "")."""
    if not token:
        return "", ""
    # root = leading letter + any accidental
    idx = 1
    while idx < len(token) and token[idx] in "#b":
        idx += 1
    # note: a b must not be taken as a flat that is part of the quality, e.g. the b of "Bb" belongs to the root
    # the idx loop above handles this; "Bbm" -> root="Bb", quality="m"
    return token[:idx], token[idx:]


def denormalize_chord(harte: str, target_style: str = "simple") -> str:
    """Convert Harte notation back to shorthand, for BTC-style output."""
    if not harte or ":" not in harte:
        return harte
    root, _, rest = harte.partition(":")
    quality, sep, slash = rest.partition("/")
    rev_map = {"maj": "", "min": "m", "min7": "m7", "sus4": "sus4"}
    q = rev_map.get(quality, quality)
    out = f"{root}{q}"
    if sep:
        out = f"{out}/{slash}"
    return out


def to_plain_chord_name(harte: str) -> str:
    """Convert Harte notation into a plain chord name, e.g. "Eb:maj" -> "Eb", "G:7" -> "G7".

    The resulting name can be parsed directly by music21's ChordSymbol.
    """
    if not harte:
        return ""
    if ":" not in harte:
        return harte
    root, _, rest = harte.partition(":")
    quality, sep, slash = rest.partition("/")
    # Harte quality -> plain suffix
    suffix = PLAIN_QUALITY_MAP.get(quality, quality)
    out = f"{root}{suffix}"
    if sep:
        out = f"{out}/{slash}"
    return out
