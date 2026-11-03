"""Key detection: a local algorithm implementation that does not depend on an LLM.

Key design points (revised after measurement on 2026-10-31):

  Inherent problem with Krumhansl-Kessler scoring: relative major/minor keys share the same set of notes
  (e.g. Eb major and C minor are both C D Eb F G Ab Bb),
  so the pitch-class distribution alone cannot separate them reliably; measured: an Eb major song is misjudged as C minor.

  We therefore use a three-part strategy:
    1. weight the first and last chords -- pop songs usually start and end on the tonic
    2. lower the weight of the third and fifth -- the root best represents a chord's functional home
    3. relative-key disambiguation -- when the best candidate and its relative key score close together,
       break the tie with the first chord (and the last chord if needed)
"""
from __future__ import annotations

from typing import Optional

from music21 import harmony as m21harmony
from music21 import key as m21key
from music21 import stream

from services.harmony.chord_normalizer import normalize_chord, to_plain_chord_name

NOTE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# key-name spelling preference (see _key_name): these pcs are more commonly written with flats
FLAT_PREFERRED = {1, 3, 6, 8, 10}
# among minor keys only Eb and Bb use flats (C#/F#/G# minor are more common than Db/Gb/Ab minor)
MINOR_FLAT_PREFERRED = {3, 10}

# Krumhansl-Kessler key profile
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.69, 2.69, 3.34, 3.17, 2.90]

# weights: the root dominates, the third and fifth are only supporting
W_ROOT = 1.0
W_THIRD = 0.35
W_FIFTH = 0.25

# positional weights
W_HEAD = 1.8    # first chord
W_TAIL = 1.8    # last chord
W_EDGE = 1.3    # the first/last three chords

# score threshold for relative-key disambiguation (relative gap)
RELATIVE_TIE_GAP = 0.18


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


def _quality_of(harte: str) -> str:
    if ":" not in harte:
        return "maj"
    return harte.partition(":")[2].partition("/")[0]


def _triad_intervals(quality: str) -> tuple[int, int]:
    q = quality.lower()
    if q.startswith("dim"):
        return 3, 6
    if q.startswith("aug"):
        return 4, 8
    if q.startswith("sus"):
        return 5, 7
    if q.startswith("min") or (q.startswith("m") and not q.startswith("maj")):
        return 3, 7
    return 4, 7


def _key_name(pc: int, mode: str) -> str:
    """pc + mode -> readable key name.

    Major and minor differ in their sharp/flat preference:
      major  Db/Eb/Gb/Ab/Bb
      minor  C#/Eb/F#/G#/Bb (only Eb and Bb minor use flats)
    Sharing one flat table would spell c#/f#/g# minor as db/gb/ab minor, which clashes with the chord spellings.
    """
    if mode == "minor":
        names = FLAT_NAMES if pc in MINOR_FLAT_PREFERRED else SHARP_NAMES
    else:
        names = FLAT_NAMES if pc in FLAT_PREFERRED else SHARP_NAMES
    return f"{names[pc]} {mode}"


def _accumulate(chord_names: list[str]) -> tuple[list[float], Optional[int], Optional[int]]:
    """Accumulate the weighted pitch-class distribution; return (counts, first chord pc, last chord pc)."""
    counts = [0.0] * 12
    first_pc = None
    last_pc = None

    n = len(chord_names)
    for idx, name in enumerate(chord_names):
        normalized = normalize_chord(name)
        if normalized is None:
            continue
        root = normalized.partition(":")[0]
        root_pc = _pc_of(root)
        if root_pc is None:
            continue

        if first_pc is None:
            first_pc = root_pc
        last_pc = root_pc

        # positional weight
        w = 1.0
        if idx == 0:
            w = W_HEAD
        elif idx == n - 1:
            w = W_TAIL
        elif idx < 3 or idx >= n - 3:
            w = W_EDGE

        quality = _quality_of(normalized)
        third, fifth = _triad_intervals(quality)

        counts[root_pc] += W_ROOT * w
        counts[(root_pc + third) % 12] += W_THIRD * w
        counts[(root_pc + fifth) % 12] += W_FIFTH * w

    return counts, first_pc, last_pc


def _score_all(counts: list[float]) -> list[tuple[float, int, str]]:
    """Score all 24 keys and return them in descending order."""
    scores = []
    for tonic_pc in range(12):
        for mode, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            score = 0.0
            for i in range(12):
                score += counts[i] * profile[(i - tonic_pc) % 12]
            scores.append((score, tonic_pc, mode))
    scores.sort(key=lambda x: x[0], reverse=True)
    return scores


def _relative_partner(pc: int, mode: str) -> Optional[tuple[int, str]]:
    """Return the (pc, mode) of the relative key.

    The relative minor of Eb major is C minor; the relative minor of C major is A minor.
    Use music21 for an exact letter-level conversion, avoiding pc drift from accidentals.
    """
    try:
        # try both spellings and take whichever one can be constructed
        for names in (FLAT_NAMES, SHARP_NAMES):
            try:
                k = m21key.Key(names[pc], mode)
                rel = k.relative
                return rel.tonic.pitchClass, rel.mode
            except Exception:
                continue
    except Exception:
        pass
    return None


def _resolve_relative(scores: list[tuple[float, int, str]],
                      first_pc: Optional[int],
                      last_pc: Optional[int]) -> Optional[tuple[float, int, str]]:
    """Relative-key disambiguation.

    If the best candidate and its relative key score close together, decide by which tonic the first/last chord points to.
    Return the accepted candidate, or None when no disambiguation is needed.
    """
    if not scores:
        return None
    best = scores[0]

    partner = _relative_partner(best[1], best[2])
    if partner is None:
        return None

    # look for the relative key among the candidates
    partner_entry = None
    for entry in scores[1:5]:
        if (entry[1], entry[2]) == partner:
            partner_entry = entry
            break
    if partner_entry is None:
        return None

    gap = (best[0] - partner_entry[0]) / best[0] if best[0] else 1.0
    if gap > RELATIVE_TIE_GAP:
        return None  # clearly separated, do not intervene

    # the scores are close, break the tie with the first chord
    if first_pc is not None:
        if first_pc == partner_entry[1]:
            return partner_entry
        if first_pc == best[1]:
            return best

    # when the first chord cannot decide, fall back to the last chord
    if last_pc is not None:
        if last_pc == partner_entry[1]:
            return partner_entry
        if last_pc == best[1]:
            return best

    return None


def detect_key_heuristic(chord_names: list[str]) -> Optional[str]:
    """Heuristic key inference, with relative-key disambiguation included."""
    valid = [c for c in chord_names if normalize_chord(c)]
    if not valid:
        return None

    counts, first_pc, last_pc = _accumulate(valid)
    scores = _score_all(counts)

    resolved = _resolve_relative(scores, first_pc, last_pc)
    chosen = resolved if resolved else scores[0]
    return _key_name(chosen[1], chosen[2])


def detect_key_heuristic_detail(chord_names: list[str]) -> dict:
    """Detailed result including the candidate list, for diagnostics and frontend display."""
    valid = [c for c in chord_names if normalize_chord(c)]
    if not valid:
        return {"primaryKey": "Unknown", "candidates": [], "relativeResolved": False}

    counts, first_pc, last_pc = _accumulate(valid)
    scores = _score_all(counts)
    resolved = _resolve_relative(scores, first_pc, last_pc)
    chosen = resolved if resolved else scores[0]

    top_score = scores[0][0] or 1.0
    candidates = [
        {
            "key": _key_name(pc, mode),
            "score": round(score, 2),
            "relative": round(score / top_score, 2),
        }
        for score, pc, mode in scores[:4]
    ]

    return {
        "primaryKey": _key_name(chosen[1], chosen[2]),
        "candidates": candidates,
        "relativeResolved": resolved is not None,
        "firstChordPc": first_pc,
        "lastChordPc": last_pc,
    }


def _build_music21_stream(chord_names: list[str]) -> stream.Stream:
    s = stream.Stream()
    for name in chord_names:
        normalized = normalize_chord(name)
        if normalized is None:
            continue
        plain = to_plain_chord_name(normalized)
        try:
            s.append(m21harmony.ChordSymbol(plain))
        except Exception:
            continue
    return s


def detect_key_music21(chord_names: list[str]) -> Optional[str]:
    """Infer the key from a chord sequence using music21."""
    valid = [c for c in chord_names if normalize_chord(c)]
    if not valid:
        return None
    try:
        s = _build_music21_stream(valid)
        detected = s.analyze("key")
        if detected is None:
            return None
        return f"{detected.tonic.name} {detected.mode}"
    except Exception:
        return None


def detect_key(chord_names: list[str]) -> dict:
    """Combined key-detection entry point.

    Returns:
        {
            "primaryKey": "Eb major",
            "confidence": 0.0~1.0,
            "method": "heuristic" | "music21" | "hybrid",
            "candidates": [...],
            "relativeResolved": bool,
        }
    """
    detail = detect_key_heuristic_detail(chord_names)
    if detail["primaryKey"] == "Unknown":
        return {
            "primaryKey": "Unknown",
            "confidence": 0.0,
            "method": "none",
            "candidates": [],
            "relativeResolved": False,
        }

    h = detail["primaryKey"]
    m = detect_key_music21(chord_names)

    # music21 outputs E-/B- style names; normalize them into readable names
    if m:
        m = _normalize_music21_key_name(m)

    base = {
        "candidates": detail["candidates"],
        "relativeResolved": detail["relativeResolved"],
    }

    if h and m:
        if h == m:
            return {"primaryKey": h, "confidence": 0.92, "method": "hybrid", **base}
        # disagreement: if the two are relative keys and disambiguation fired, take the heuristic result
        if detail["relativeResolved"]:
            return {"primaryKey": h, "confidence": 0.85, "method": "hybrid", **base}
        return {"primaryKey": h, "confidence": 0.6, "method": "hybrid", **base}

    if h:
        return {"primaryKey": h, "confidence": 0.75, "method": "heuristic", **base}
    return {"primaryKey": m, "confidence": 0.7, "method": "music21", **base}


def _normalize_music21_key_name(name: str) -> str:
    """Convert music21's 'E- major' / 'B- minor' into 'Eb major' / 'Bb minor'."""
    parts = name.split()
    if not parts:
        return name
    tonic = parts[0].replace("-", "b").replace("+", "#")
    mode = parts[1] if len(parts) > 1 else "major"
    return f"{tonic} {mode}"
