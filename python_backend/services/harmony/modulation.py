"""Modulation detection: identify abrupt local key changes with a sliding window.

Corresponds to item 14 of FEATURE_SCOPE. It only marks points; it writes no explanation.

Design evolution (2026-10-31):
  v1 plain sliding window -> relative major/minor was reported massively as false positives
  v2 excluded relative keys entirely -> missed genuine relative modulations (the user reported this)
  v3 (this version) separates real from false with the "tonic occurrence rate":

    real modulation: the new tonic appears often in the new section while the old tonic fades out
    false positive: the local window happens to lack the tonic chord, but the old tonic is still frequent

  Criteria:
    - a relative-key modulation is accepted only when the new tonic ratio >= RELATIVE_MIN_TONIC
    - the old tonic ratio <= RELATIVE_MAX_OLD_TONIC (meaning the key was genuinely left)
    - relative keys need support from more consecutive windows (more conservative than non-relative ones)

  v4 (2026-11) adds "fit + duration" thresholds, see MIN_FIT_NEW / MIN_FIT_MARGIN /
  MIN_SECTION_CHORDS: relying on "two consecutive windows agree" alone mistakes local noise for a modulation.
  Also, when /api/analyze-harmony has audio it prefers the key curve from the madmom key CNN
  (services/harmony/audio_key.py) to define sections; this module is only the fallback when there is no audio.
"""
from __future__ import annotations

from typing import Optional

from music21 import key as m21key

from services.harmony.chord_normalizer import normalize_chord
from services.harmony.key_detector import _key_name, detect_key_heuristic
from services.harmony.roman_analyzer import is_diatonic

DEFAULT_WINDOW = 8
DEFAULT_STEP = 4

# non-relative key: 2 consecutive windows are enough
MIN_WINDOWS_DIRECT = 2
# relative key: more conservative, needs 3 windows and solid tonic evidence
MIN_WINDOWS_RELATIVE = 3
RELATIVE_MIN_TONIC = 0.18      # the new tonic is at least 18% of the chords
RELATIVE_MAX_OLD_TONIC = 0.12  # the old tonic ratio drops below 12%

# Evidence thresholds added in v4. Why: sliding-window local keys are noisy on their own --
# a measured *single-key* Eb major song flips 9 times across 8-chord windows (the same for music21's Krumhansl profile).
# Counting "two consecutive windows agree" as proof turns noise into a modulation, so we must additionally require:
#   1) the new key has a high enough in-key chord ratio in that section (fit)
#   2) the new key fits noticeably better than the old one (fit margin)
#   3) enough music remains after the modulation point (avoids noise from the last two or three bars)
MIN_FIT_NEW = 0.60     # lower bound on the in-key chord ratio of the new key
MIN_FIT_MARGIN = 0.15  # lower bound on new-key fit minus old-key fit
MIN_SECTION_CHORDS = 8  # at least this many chords must remain after the modulation point

NOTE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def parse_key(key_str: str) -> Optional[tuple[int, str]]:
    """Parse "Eb major" into (pc, mode)."""
    if not key_str or key_str == "Unknown":
        return None
    parts = key_str.split()
    if not parts:
        return None
    tonic = parts[0]
    mode = parts[1] if len(parts) > 1 else "major"
    try:
        k = m21key.Key(tonic, mode)
        return k.tonic.pitchClass, k.mode
    except Exception:
        if tonic[0] not in NOTE_PC:
            return None
        pc = NOTE_PC[tonic[0]]
        for ch in tonic[1:]:
            if ch == "#":
                pc += 1
            elif ch == "b":
                pc -= 1
        return pc % 12, mode


def are_relative_keys(a: str, b: str) -> bool:
    """Return whether two keys are relative major/minor (same pitch classes, different tonic)."""
    pa = parse_key(a)
    pb = parse_key(b)
    if not pa or not pb:
        return False
    (pc_a, mode_a), (pc_b, mode_b) = pa, pb
    if mode_a == mode_b:
        return False
    diff = (pc_a - pc_b) % 12
    if mode_a == "major" and mode_b == "minor":
        return diff == 3
    if mode_a == "minor" and mode_b == "major":
        return diff == 9
    return False


def _root_pc(chord: str) -> Optional[int]:
    """Pitch class of the chord root."""
    normalized = normalize_chord(chord)
    if normalized is None:
        return None
    root = normalized.partition(":")[0]
    if not root or root[0] not in NOTE_PC:
        return None
    pc = NOTE_PC[root[0]]
    for ch in root[1:]:
        if ch == "#":
            pc += 1
        elif ch == "b":
            pc -= 1
        else:
            break
    return pc % 12


def tonic_ratio(chords: list[str], key_str: str) -> float:
    """Tonic ratio: the share of chords whose root is the tonic of that key."""
    parsed = parse_key(key_str)
    if not parsed:
        return 0.0
    tonic_pc = parsed[0]
    valid = [c for c in chords if normalize_chord(c)]
    if not valid:
        return 0.0
    hits = sum(1 for c in valid if _root_pc(c) == tonic_pc)
    return hits / len(valid)


def _valid_chords(chord_names: list[str]) -> list[str]:
    return [c for c in chord_names if normalize_chord(c)]


def key_fit_ratio(chords: list[str], key_str: str) -> float:
    """Share of in-key chords for that key -- the main evidence for modulation decisions.

    Far more robust than the tonic ratio: a local window often lacks the tonic chord, yet in-key chords still dominate.
    """
    parsed = parse_key(key_str)
    if not parsed:
        return 0.0
    key_pc, mode = parsed

    hits = 0
    total = 0
    for chord in chords:
        normalized = normalize_chord(chord)
        if normalized is None:
            continue
        root, _, rest = normalized.partition(":")
        quality = rest.partition("/")[0]
        root_pc = _root_pc(chord)
        if root_pc is None:
            continue
        total += 1
        if is_diatonic(root_pc, quality, key_pc, mode):
            hits += 1
    return hits / total if total else 0.0


def _windowed_keys(chord_names: list[str], window: int, step: int) -> list[dict]:
    results = []
    n = len(chord_names)
    if n == 0:
        return results
    if n <= window:
        key = detect_key_heuristic(chord_names)
        return [{"start": 0, "end": n, "key": key, "chords": chord_names}] if key else []

    for start in range(0, n - window + 1, step):
        chunk = chord_names[start:start + window]
        key = detect_key_heuristic(chunk)
        if key:
            results.append({
                "start": start,
                "end": start + window,
                "key": key,
                "chords": chunk,
            })
    return results


def _judge_run(run: list[dict], current_key: str, run_key: str, tail_chords: int = 0) -> bool:
    """Decide whether a run of consecutive windows is a real modulation (v4: fit + duration thresholds).

    Args:
        run: windows that consecutively point to run_key
        current_key: the currently active key
        run_key: candidate new key
        tail_chords: number of chords remaining after the candidate modulation point
    """
    relative = are_relative_keys(run_key, current_key)
    min_windows = MIN_WINDOWS_RELATIVE if relative else MIN_WINDOWS_DIRECT

    if len(run) < min_windows:
        return False
    # local key changes near the end are mostly noise and not worth marking
    if tail_chords < MIN_SECTION_CHORDS:
        return False

    all_chords = [c for w in run for c in w["chords"]]
    new_fit = key_fit_ratio(all_chords, run_key)
    old_fit = key_fit_ratio(all_chords, current_key)

    if new_fit < MIN_FIT_NEW:
        return False
    if new_fit - old_fit < MIN_FIT_MARGIN:
        return False

    if relative:
        new_ratio = tonic_ratio(all_chords, run_key)
        old_ratio = tonic_ratio(all_chords, current_key)
        # the new tonic must be common enough and the old tonic must fade out
        return new_ratio >= RELATIVE_MIN_TONIC and old_ratio <= RELATIVE_MAX_OLD_TONIC

    return True


def detect_modulations(chord_names: list[str],
                       primary_key: str,
                       window: int = DEFAULT_WINDOW,
                       step: int = DEFAULT_STEP) -> list[dict]:
    """Detect genuine key changes."""
    valid = _valid_chords(chord_names)
    if not valid or not primary_key:
        return []

    windows = _windowed_keys(valid, window, step)
    if not windows:
        return []

    modulations = []
    current_key = primary_key
    run: list[dict] = []
    run_key: Optional[str] = None

    for i, w in enumerate(windows):
        k = w["key"]

        # back to the current key: clear the candidate
        if k == current_key:
            run = []
            run_key = None
            continue

        # continue the same candidate
        if k == run_key:
            run.append(w)
        else:
            run = [w]
            run_key = k

        # evaluate on every window; enough evidence means it is accepted
        if run_key and _judge_run(run, current_key, run_key,
                                  tail_chords=len(valid) - run[0]["start"]):
            # the next window returns to the original key right away -> just passing through, do not mark
            next_key = windows[i + 1]["key"] if i + 1 < len(windows) else None
            if next_key == current_key:
                continue
            modulations.append({
                "fromKey": current_key,
                "toKey": run_key,
                "atIndex": run[0]["start"],
                "isRelative": are_relative_keys(run_key, current_key),
                "source": "chords",
            })
            current_key = run_key
            run = []
            run_key = None

    return modulations


def build_sections(chord_names: list[str],
                   primary_key: str,
                   modulations: list[dict]) -> list[dict]:
    """Cut the chord sequence into key sections that cover every index with no gaps."""
    valid = _valid_chords(chord_names)
    if not valid:
        return []

    total = len(valid)
    boundaries = sorted(modulations, key=lambda m: m["atIndex"])

    sections = []
    start = 0
    cur_key = primary_key
    for mod in boundaries:
        idx = max(start, min(mod["atIndex"], total - 1))
        if idx > start:
            sections.append({
                "startIndex": start,
                "endIndex": idx - 1,
                "key": cur_key,
                "chords": valid[start:idx],
            })
            start = idx
        cur_key = mod["toKey"]

    if start < total:
        sections.append({
            "startIndex": start,
            "endIndex": total - 1,
            "key": cur_key,
            "chords": valid[start:],
        })

    return sections
