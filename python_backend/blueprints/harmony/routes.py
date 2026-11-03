"""Music-theory analysis blueprint: /api/analyze-harmony

The response shape is compatible with the existing /api/detect-key, so the frontend can switch over smoothly.

v4 (2026-11) fixes:
  - correctedChords is padded with placeholders and no longer shifts one position left of the input (old bug: the filtered sequence
    was returned as the result directly, so it was shorter than the input and the frontend's index alignment drifted)
  - roman numerals are analysed per **section key**, so after a modulation the output is no longer full of #V/#VI; temporalShifts is actually populated
  - with audio, the madmom key CNN (services/harmony/audio_key.py) determines key and sections,
    and without audio we fall back to the chord-sequence heuristic
"""
from __future__ import annotations

from typing import Any, Optional

from flask import Blueprint, jsonify, request

from services.harmony import (
    analyze_sequence,
    build_sections,
    correct_sequence,
    detect_key,
    detect_modulations,
    normalize_chord,
)
from services.harmony.audio_key import analyze as analyze_audio_key
from services.harmony.modulation import parse_key
from services.cache import cache_service
from utils.logging import log_error, log_info

harmony_bp = Blueprint("harmony", __name__)

# engine cache version: must be bumped by 1 whenever the analysis semantics change, or stale results keep being reused
ENGINE_VERSION = 5
# audio key-curve cache (the CNN is not re-run for the same audio; one run is about 5~10 seconds)
AUDIO_KEY_CACHE_VERSION = "v1"


def _cache_disabled() -> bool:
    """Honour ``nocache=1`` on the query string."""
    flag = request.args.get("nocache")
    return str(flag or "").strip().lower() in ("1", "true", "yes")


def _extract_chords(raw_chords: list) -> tuple[list[str], list[Optional[float]]]:
    """Accept both the string form and the {chord, time} form, and keep the time column."""
    names: list[str] = []
    times: list[Optional[float]] = []
    for item in raw_chords:
        if isinstance(item, str):
            names.append(item)
            times.append(None)
        elif isinstance(item, dict):
            names.append(str(item.get("chord", "")))
            value = item.get("time")
            times.append(float(value) if isinstance(value, (int, float)) else None)
        else:
            names.append(str(item))
            times.append(None)
    return names, times


def _index_for_time(times: list[Optional[float]],
                    boundary: float,
                    duration: float,
                    total: int) -> int:
    """Seconds -> chord index; without timestamps, scale linearly by the total duration."""
    if total <= 0:
        return 0
    if any(t is not None for t in times):
        for idx, t in enumerate(times):
            if t is not None and t >= boundary:
                return idx
        return total - 1
    if duration > 0:
        return max(0, min(total - 1, int(round(boundary / duration * total))))
    return 0


def _sections_from_audio(audio: dict,
                         times: list[Optional[float]],
                         total: int) -> list[dict]:
    """Map the audio key segments onto sections that cover every chord index."""
    raw = audio.get("sections") or []
    if not raw or total <= 0:
        return []

    duration = float(audio.get("duration") or 0.0)
    sections: list[dict] = []
    for sec in raw:
        start = _index_for_time(times, float(sec.get("start") or 0.0), duration, total)
        end = _index_for_time(times, float(sec.get("end") or 0.0), duration, total) - 1
        if end < start:
            end = start
        sections.append({
            "startIndex": start,
            "endIndex": end,
            "key": sec.get("key"),
            "confidence": sec.get("confidence"),
        })

    merged: list[dict] = []
    for sec in sections:
        if merged and merged[-1]["key"] == sec["key"]:
            merged[-1]["endIndex"] = max(merged[-1]["endIndex"], sec["endIndex"])
            continue
        if merged:
            sec["startIndex"] = merged[-1]["endIndex"] + 1
        merged.append(sec)

    merged[0]["startIndex"] = 0
    merged[-1]["endIndex"] = total - 1
    return merged


def _roman_by_sections(normalized: list[Optional[str]],
                       sections: list[dict]) -> list[str]:
    """Analyse roman numerals section by section with that section's key; output is as long as the input (N.C. where there is no chord)."""
    romans = ["N.C."] * len(normalized)
    for sec in sections:
        start = max(0, int(sec["startIndex"]))
        end = min(len(normalized) - 1, int(sec["endIndex"]))
        chunk = [c for c in normalized[start:end + 1] if c]
        if not chunk:
            continue
        seg = analyze_sequence(chunk, sec["key"])
        cursor = 0
        for idx in range(start, end + 1):
            if normalized[idx] is None:
                continue
            value = seg[cursor] if cursor < len(seg) else None
            romans[idx] = value if value else "?"
            cursor += 1
    return romans


def _same_key(a: Optional[str], b: Optional[str]) -> bool:
    if not a or not b:
        return False
    pa, pb = parse_key(a), parse_key(b)
    if pa and pb:
        return pa == pb
    return a == b


def _audio_key_for(audio_id: Optional[str]) -> Optional[dict]:
    """Get the audio key (cache first). Any failure returns None and does not affect the chord path."""
    if not audio_id:
        return None
    path = cache_service.audio_path(audio_id)
    if not path:
        return None

    cache_key = f"audioKey:{AUDIO_KEY_CACHE_VERSION}:{audio_id}"
    try:
        cached = cache_service.kv_get(cache_key)
        if isinstance(cached, dict) and cached.get("primaryKey"):
            return cached
    except Exception:  # noqa: BLE001
        pass

    result = analyze_audio_key(str(path))
    if result:
        try:
            cache_service.kv_set(cache_key, result)
        except Exception:  # noqa: BLE001
            pass
    return result


@harmony_bp.route("/api/analyze-harmony", methods=["POST"])
def analyze_harmony():
    """Produce key, roman numerals, spelling correction and modulation marks from a chord sequence.

    Request JSON:
      {
        "chords": [{"chord": "Eb:maj", "time": 1.32}, ...],
             or ["Eb:maj", "G:7", ...],
        "includeRomanNumerals": true,
        "includeEnharmonicCorrection": true,
        "audioId": "3065..."      # optional: audio already in the local store, used for the madmom key CNN
      }
    """
    try:
        payload = request.get_json(silent=True) or {}
        raw_chords = payload.get("chords") or []
        if not raw_chords:
            return jsonify({"error": "chords is required"}), 400

        if not isinstance(raw_chords, list):
            return jsonify({"error": "chords must be an array"}), 400

        chord_names, times = _extract_chords(raw_chords)

        include_roman = bool(payload.get("includeRomanNumerals", True))
        include_enharmonic = bool(payload.get("includeEnharmonicCorrection", True))
        audio_id = payload.get("audioId") or payload.get("audio_id")
        audio_id = str(audio_id) if audio_id else None

        # local cache: the same chord sequence + options reuse the previous analysis directly
        cache_input: dict[str, Any] = {
            "_v": ENGINE_VERSION,
            "chords": chord_names,
            "includeRomanNumerals": include_roman,
            "includeEnharmonicCorrection": include_enharmonic,
            "audioId": audio_id,
        }
        cache_disabled = _cache_disabled()
        if not cache_disabled:
            cached = cache_service.lookup_analysis("harmony", input_payload=cache_input)
            if cached:
                log_info(f"Harmony cache hit ({len(chord_names)} chords)")
                return jsonify(cache_service.replay(cached["payload"], cached))

        # 1. normalization
        normalized = [normalize_chord(c) for c in chord_names]
        valid = [c for c in normalized if c]

        # 2. key: audio (madmom CNN) first, with the chord heuristic as a cross-check and fallback
        key_result = detect_key(valid)
        chord_key = key_result["primaryKey"]
        primary_key = chord_key
        key_method = key_result["method"]
        key_confidence = key_result["confidence"]
        key_source = "chords"
        key_conflict = False
        audio_key: Optional[dict] = None
        if audio_id:
            audio_key = _audio_key_for(audio_id)
            if audio_key and audio_key.get("primaryKey"):
                key_source = "audio"
                key_conflict = not _same_key(chord_key, audio_key["primaryKey"])
                primary_key = audio_key["primaryKey"]
                key_method = audio_key.get("method") or "madmom-cnn"
                key_confidence = float(audio_key.get("confidence") or 0.0)

        result: dict[str, Any] = {
            "primaryKey": primary_key,
            "modulation": None,
            "originalChords": chord_names,
            "fromCache": False,
            "fromHeuristicFallback": False,
            "keyMethod": key_method,
            "keyConfidence": key_confidence,
            "keySource": key_source,
            "chordKey": chord_key,
            "chordKeyMethod": key_result["method"],
            "chordKeyConfidence": key_result["confidence"],
            "keyConflict": key_conflict,
        }

        # 3. spelling correction: pad to the same length as the input first, so later index alignment cannot drift
        original_seq = [c if c is not None else "N.C." for c in normalized]
        if include_enharmonic:
            corr = correct_sequence(valid, primary_key)
            corr_iter = iter(corr["correctedSequence"])
            corrected_full: list[str] = []
            for c in normalized:
                if c is None:
                    corrected_full.append("N.C.")
                    continue
                try:
                    corrected_full.append(next(corr_iter))
                except StopIteration:
                    corrected_full.append(c)
            result["correctedChords"] = corrected_full
            result["corrections"] = corr["corrections"]
        else:
            result["correctedChords"] = original_seq
            result["corrections"] = {}

        # 4. modulations and sections: the audio curve first, otherwise the chord sliding window (now with fit thresholds)
        total = len(normalized)
        modulations: list[dict] = []
        sections: list[dict] = []
        if audio_key:
            sections = _sections_from_audio(audio_key, times, total)
            for idx, sec in enumerate(sections[1:], start=1):
                modulations.append({
                    "fromKey": sections[idx - 1]["key"],
                    "toKey": sec["key"],
                    "atIndex": sec["startIndex"],
                    "isRelative": False,
                    "source": "audio",
                })
        if not sections:
            modulations = detect_modulations(valid, primary_key)
            sections = build_sections(valid, primary_key, modulations)
            # build_sections indexes the sequence with the no-chord positions removed; convert back to the original indices
            if sections:
                positions = [i for i, c in enumerate(normalized) if c]
                for sec in sections:
                    a = min(sec["startIndex"], len(positions) - 1)
                    b = min(sec["endIndex"], len(positions) - 1)
                    sec["startIndex"] = positions[a]
                    sec["endIndex"] = positions[b]

        if modulations:
            result["modulation"] = modulations[0]["toKey"]
        result["modulations"] = modulations

        # 5. roman numerals: analyse section by section with each section's key, so a span is no longer analysed entirely in the old key after a modulation
        if include_roman:
            romans_padded = _roman_by_sections(normalized, sections)
            temporal_shifts = [
                {
                    "index": sec["startIndex"],
                    "fromKey": sections[idx - 1]["key"],
                    "toKey": sec["key"],
                }
                for idx, sec in enumerate(sections[1:], start=1)
            ]
            result["romanNumerals"] = {
                "analysis": romans_padded,
                "keyContext": primary_key,
                "temporalShifts": temporal_shifts,
                "sections": [
                    {"startIndex": s["startIndex"], "endIndex": s["endIndex"], "key": s["key"]}
                    for s in sections
                ],
            }

            # the two arrays of sequenceCorrections must be as long as the input and correspond position by position.
            # the frontend's buildLegacyCorrections aligns by index, so a length mismatch makes
            # every following chord drift (showing up as chords mysteriously turning into N.C.).
            result["sequenceCorrections"] = {
                "originalSequence": original_seq,
                "correctedSequence": result["correctedChords"],
                "keyAnalysis": {
                    "sections": sections,
                    "modulations": modulations,
                },
            }
        else:
            result["romanNumerals"] = None
            result["sequenceCorrections"] = None

        if not cache_disabled:
            cache_service.store_analysis("harmony", result, input_payload=cache_input)

        # Write the authoritative key back onto the audio's cached chords / beats rows: the home page's "recent"
        # list folds by audio_id and takes its key from here (detect-key results arrive after the chord analysis).
        if audio_id and primary_key:
            cache_service.set_audio_key(audio_id, primary_key)

        return jsonify(result)

    except Exception as e:
        log_error(f"analyze-harmony error: {e}")
        return jsonify({"error": f"Failed to analyze harmony: {e}"}), 500


@harmony_bp.route("/api/analyze-harmony/info", methods=["GET"])
def harmony_info():
    """Engine info, for the frontend to probe capabilities."""
    engine = "music21 + harte-library + madmom-key-cnn"
    try:
        import music21
        m21_version = music21.__version__
    except Exception:  # noqa: BLE001
        m21_version = "unavailable"

    audio_key_ready = False
    try:
        from services.harmony.audio_key import available as audio_key_available
        audio_key_ready = audio_key_available()
    except Exception:  # noqa: BLE001
        audio_key_ready = False

    return jsonify({
        "engine": engine,
        "engineVersion": ENGINE_VERSION,
        "music21_version": m21_version,
        "audioKeyAvailable": audio_key_ready,
        "supports": [
            "key_detection",
            "audio_key_detection",
            "roman_numerals",
            "figure_bass_inversions",
            "enharmonic_correction",
            "modulation_detection",
            "section_aware_roman_numerals",
        ],
    })
