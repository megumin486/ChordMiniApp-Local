"""Audio key analysis (madmom key CNN) -- the authoritative check on the music-theory rule engine.

Why it is needed
------------
Deciding key/modulation from chord sequences, as done above, is essentially guessing the key from symbols. Measured:
  - global: four Krumhansl/Temperley profiles plus our heuristic all give Eb major, which is fine;
  - sliding window: 8-chord windows flip 9 times on a **single-key** song (music21 does the same),
    so false modulation reports are inherent to a naive sliding window, not a matter of badly tuned coefficients.
madmom's key CNN (Korzeniowski & Widmer, ISMIR 2018) listens to the audio directly:
measured on test.mp3: global Eb major with 0.982 confidence; run on 15-second slices, all 16 segments give
Eb major (0.545 ~ 0.995). That is exactly what we need to tell a real modulation from model noise.

Cost: 1.9s for a whole song, about 0.8s per 20-second chunk (CPU). Results are cached by audio_id.

Output spelling matches key_detector._key_name (major Db/Eb/Gb/Ab/Bb, minor C#/Eb/F#/G#/Bb).
"""
from __future__ import annotations

from typing import Any, Optional

from services.harmony.key_detector import _key_name, _pc_of

# chunking parameters: 20-second window / 10-second hop, balancing time resolution against CPU cost
DEFAULT_CHUNK_SECONDS = 20.0
DEFAULT_HOP_SECONDS = 10.0
# segments shorter than this are not judged on their own (the CNN is trained on longer context)
MIN_CHUNK_SECONDS = 8.0
# runs of the same key shorter than this many chunks merge into a neighbouring section (debounce)
MIN_SECTION_CHUNKS = 2

METHOD = "madmom-cnn"

_PROCESSOR: Any = None
_LABELS: Optional[list[str]] = None


def _load_processor():
    """Lazily load the CNN (about 1s to load the model; reused within the process)."""
    global _PROCESSOR, _LABELS
    if _PROCESSOR is None:
        from madmom.features.key import KEY_LABELS, CNNKeyRecognitionProcessor

        _PROCESSOR = CNNKeyRecognitionProcessor()
        _LABELS = list(KEY_LABELS)
    return _PROCESSOR, _LABELS


def available() -> bool:
    """Whether the madmom key CNN is available (False when the model or a dependency is missing; never raises)."""
    try:
        _load_processor()
        return True
    except Exception:  # noqa: BLE001
        return False


def label_to_key(label: str) -> Optional[str]:
    """Convert madmom's ``"Eb major"`` into this engine's key-name spelling."""
    if not label:
        return None
    parts = label.split()
    if len(parts) < 2:
        return None
    tonic, mode = parts[0], parts[1]
    pc = _pc_of(tonic)
    if pc is None:
        return None
    return _key_name(pc, "minor" if mode.startswith("min") else "major")


def _sections_from_curve(curve: list[dict], min_chunks: int = MIN_SECTION_CHUNKS) -> list[dict]:
    """Compress the per-chunk keys into sections and absorb overly short sections (debounce).

    Conservative only: a section shorter than ``min_chunks`` merges into the previous one (into the next one if there is none).
    """
    if not curve:
        return []

    merged: list[dict] = []
    for item in curve:
        if merged and merged[-1]["key"] == item["key"]:
            merged[-1]["end"] = item["end"]
            merged[-1]["chunks"] += 1
            merged[-1]["confidence"] = max(merged[-1]["confidence"], item["confidence"])
        else:
            merged.append({
                "key": item["key"],
                "start": item["start"],
                "end": item["end"],
                "confidence": item["confidence"],
                "chunks": 1,
            })

    changed = True
    while changed and len(merged) > 1:
        changed = False
        for idx, sec in enumerate(merged):
            if sec["chunks"] >= min_chunks:
                continue
            if idx > 0:
                merged[idx - 1]["end"] = sec["end"]
                merged[idx - 1]["chunks"] += sec["chunks"]
                merged.pop(idx)
            else:
                merged[1]["start"] = sec["start"]
                merged[1]["chunks"] += sec["chunks"]
                merged[1]["confidence"] = max(merged[1]["confidence"], sec["confidence"])
                merged.pop(idx)
            changed = True
            break

    return merged


def analyze(audio_path: str,
            chunk_seconds: float = DEFAULT_CHUNK_SECONDS,
            hop_seconds: float = DEFAULT_HOP_SECONDS) -> Optional[dict]:
    """Audio -> {primaryKey, confidence, curve, sections}.

    Returns None on failure (the caller should fall back to the chord-sequence heuristic); never raises.
    """
    try:
        import numpy as np
        from madmom.audio.signal import Signal

        proc, labels = _load_processor()

        whole = np.asarray(proc(audio_path)).flatten()
        idx = int(np.argmax(whole))
        primary = label_to_key(labels[idx])
        if primary is None:
            return None
        result: dict = {
            "method": METHOD,
            "primaryKey": primary,
            "confidence": round(float(whole[idx]), 4),
            "curve": [],
            "sections": [],
        }

        sig = Signal(audio_path, num_channels=1, sample_rate=44100)
        sr = int(sig.sample_rate)
        total = len(sig)
        duration = total / float(sr) if sr else 0.0
        result["duration"] = round(duration, 3)
        if duration < min(chunk_seconds, MIN_CHUNK_SECONDS) * 2:
            return result

        starts: list[float] = []
        t = 0.0
        while t + chunk_seconds <= duration:
            starts.append(t)
            t += hop_seconds
        # make sure the tail is covered
        if duration - chunk_seconds > starts[-1]:
            starts.append(max(0.0, duration - chunk_seconds))

        curve: list[dict] = []
        for start in starts:
            a = int(start * sr)
            b = min(total, int((start + chunk_seconds) * sr))
            if b - a < MIN_CHUNK_SECONDS * sr:
                continue
            prob = np.asarray(proc(sig[a:b])).flatten()
            best = int(np.argmax(prob))
            key = label_to_key(labels[best])
            if key is None:
                continue
            curve.append({
                "start": round(start, 3),
                "end": round(b / float(sr), 3),
                "key": key,
                "confidence": round(float(prob[best]), 4),
            })

        result["curve"] = curve
        result["sections"] = _sections_from_curve(curve)
        return result
    except Exception:  # noqa: BLE001
        return None
