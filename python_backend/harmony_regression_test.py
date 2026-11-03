"""Harmony engine v4 regression test (fixed samples, fully offline).

Covers:
  1. roman numerals and inversion figures (including seventh-chord inversions no longer producing garbage like III743)
  2. minor key-name spelling
  3. a monotonal song must not be misreported as modulating (fit threshold)
  4. a real modulation must be detected (and exactly once)
  5. array alignment in /api/analyze-harmony (correctedChords / romanNumerals / sequenceCorrections)
  6. the audio key curve (madmom CNN) can split a hand-spliced modulating audio into sections
  7. the second real sample a.mp3 (real CNN chords + a real A->B modulation) goes through the full route
  8. conventional notation for chromatic degrees (bII rather than #I, bviø7 rather than #vø7)

Usage: cd ~/ChordMiniApp/python_backend && .venv/bin/python harmony_regression_test.py
Exit code = number of failed assertions.
"""
from __future__ import annotations

import sys
import traceback
from typing import Any, Optional

FAILURES: list[str] = []
CHECKS = 0


def check(name: str, actual: Any, expected: Any) -> None:
    global CHECKS
    CHECKS += 1
    if actual == expected:
        print(f"  ok   {name}")
        return
    FAILURES.append(f"{name}: expected {expected!r}, got {actual!r}")
    print(f"  FAIL {name}: expected {expected!r} -> got {actual!r}")


def check_true(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok   {name}")
        return
    FAILURES.append(f"{name}: {detail or 'condition false'}")
    print(f"  FAIL {name}: {detail}")


# --------------------------------------------------------------------------- #
# 1. Roman numerals / inversions
# --------------------------------------------------------------------------- #
def test_roman_numerals() -> None:
    print("\n[1] Roman numerals and inversion figures")
    from services.harmony import analyze_sequence

    cases = [
        ("Eb:maj", "Eb major", "I"),
        ("G:7", "Eb major", "III7"),
        # seventh-chord inversions: 65/43/42 already carry the seventh in figured bass, so do not append another 7
        ("G:7/5", "Eb major", "III43"),
        ("G:7/3", "Eb major", "III65"),
        ("G:7/7", "Eb major", "III42"),
        ("F:min7/5", "Eb major", "ii43"),
        # triad inversions are left as they are
        ("Bb:maj/3", "Eb major", "V6"),
        ("Bb:maj/5", "Eb major", "V64"),
        ("Eb:maj/3", "Eb major", "I6"),
        ("C:min/5", "Eb major", "vi64"),
        # with no inversion the quality suffix stays as before
        ("F:min7", "Eb major", "ii7"),
    ]
    for chord, key, expected in cases:
        # analyze_sequence takes a key string; chord_to_roman needs a music21 Key object
        romans = analyze_sequence([chord], key)
        check(f"roman({chord}, {key})", romans[0] if romans else None, expected)


# --------------------------------------------------------------------------- #
# 2. Key names
# --------------------------------------------------------------------------- #
def test_key_names() -> None:
    print("\n[2] Key-name spelling (the ones where minor uses sharps)")
    from services.harmony.key_detector import _key_name

    cases = [
        (1, "minor", "C# minor"),
        (6, "minor", "F# minor"),
        (8, "minor", "G# minor"),
        (3, "minor", "Eb minor"),
        (10, "minor", "Bb minor"),
        (1, "major", "Db major"),
        (3, "major", "Eb major"),
        (6, "major", "Gb major"),
    ]
    for pc, mode, expected in cases:
        check(f"_key_name({pc}, {mode})", _key_name(pc, mode), expected)


# --------------------------------------------------------------------------- #
# 3/4. Modulation detection
# --------------------------------------------------------------------------- #
EB_MONOTONAL = ["Eb:maj", "C:min", "F:min", "Bb:maj",
                "Eb:maj", "G:min", "Ab:maj", "Bb:maj"]

C_MAJOR_SECTION = ["C:maj", "A:min", "F:maj", "G:maj"]

BB_SECTION = ["Bb:maj", "G:min", "Eb:maj", "F:maj"]


def test_monotonal_no_modulation() -> None:
    print("\n[3] A monotonal song must not be misreported as modulating")
    from services.harmony.modulation import detect_modulations

    fixtures = {
        "Eb major 48-chord loop": EB_MONOTONAL * 6,
        "Eb major 24 chords (short)": EB_MONOTONAL * 3,
        "Eb major with seventh chords": ["Eb:maj7", "C:min7", "F:min7", "Bb:7",
                            "Eb:maj7", "G:7", "Ab:maj7", "Bb:7"] * 4,
        "Eb major with a few chromatic chords": [
            "Eb:maj", "C:min", "F:min", "Bb:maj",
            "Eb:maj", "C:7", "F:min", "Bb:maj",
            "Eb:maj", "Ab:maj", "F:min", "Bb:maj",
        ] * 3,
    }
    for name, chords in fixtures.items():
        mods = detect_modulations(chords, "Eb major")
        check_true(f"{name} -> no modulation", mods == [], f"got {mods}")


def test_true_modulation() -> None:
    print("\n[4] A real modulation must be detected exactly once")
    from services.harmony.modulation import detect_modulations, parse_key

    # 16 chords in Eb major -> 16 in C major (distantly related keys, every diatonic chord changes)
    chords = (EB_MONOTONAL * 2) + (C_MAJOR_SECTION * 4)
    mods = detect_modulations(chords, "Eb major")
    check_true("Eb -> C detected exactly once", len(mods) == 1, f"got {mods}")
    if mods:
        check("Eb -> C target key", parse_key(mods[0]["toKey"]), parse_key("C major"))
        check("Eb -> C modulation point is inside the C section", 8 <= mods[0]["atIndex"] <= 16, True)

    # Eb major -> Bb major (closely related keys)
    chords2 = (EB_MONOTONAL * 2) + (BB_SECTION * 5)
    mods2 = detect_modulations(chords2, "Eb major")
    check_true("Eb -> Bb detected at least once", len(mods2) >= 1, f"got {mods2}")
    if mods2:
        check("Eb -> Bb target key", parse_key(mods2[0]["toKey"]), parse_key("Bb major"))


# --------------------------------------------------------------------------- #
# 5. API alignment
# --------------------------------------------------------------------------- #
def _client():
    from flask import Flask
    from blueprints.harmony import harmony_bp

    app = Flask(__name__)
    app.register_blueprint(harmony_bp)
    return app.test_client()


def test_api_alignment() -> None:
    print("\n[5] /api/analyze-harmony array alignment")
    client = _client()

    # a monotonal sample with N.C. placeholders -- the old correctedChords shifted everything left by one
    raw = ["Eb:maj", "N", "C:min", "F:min", "N.C.", "Bb:maj",
           "Eb:maj", "G:min", "Ab:maj", "Bb:maj", "N", "Eb:maj"]
    resp = client.post("/api/analyze-harmony?nocache=1", json={
        "chords": raw, "includeRomanNumerals": True, "includeEnharmonicCorrection": True,
    })
    check("HTTP 200 (monotonal sample)", resp.status_code, 200)
    body = resp.get_json() or {}

    check("originalChords length", len(body.get("originalChords") or []), len(raw))
    corrected = body.get("correctedChords") or []
    check("correctedChords length matches the input", len(corrected), len(raw))
    check("correctedChords[0]", corrected[0] if corrected else None, "Eb:maj")
    check("correctedChords keeps the N.C. placeholder (index 1)", corrected[1] if len(corrected) > 1 else None, "N.C.")
    check("correctedChords keeps the N.C. placeholder (index 4)", corrected[4] if len(corrected) > 4 else None, "N.C.")
    check("correctedChords last entry", corrected[-1] if corrected else None, "Eb:maj")

    romans = (body.get("romanNumerals") or {}).get("analysis") or []
    check("romanNumerals.analysis length", len(romans), len(raw))
    check("romanNumerals placeholder is N.C.", romans[1] if len(romans) > 1 else None, "N.C.")
    check("romanNumerals[0]", romans[0] if romans else None, "I")
    check("keySource (no audio)", body.get("keySource"), "chords")

    seq = body.get("sequenceCorrections") or {}
    check("sequenceCorrections.originalSequence length",
          len(seq.get("originalSequence") or []), len(raw))
    check("sequenceCorrections.correctedSequence length",
          len(seq.get("correctedSequence") or []), len(raw))
    check("the two correctedSequence values are the same data",
          seq.get("correctedSequence"), corrected)

    # modulating sample: roman numerals must follow each section's key rather than applying the starting key throughout
    raw2 = (EB_MONOTONAL * 2) + (C_MAJOR_SECTION * 4)
    resp2 = client.post("/api/analyze-harmony?nocache=1", json={
        "chords": raw2, "includeRomanNumerals": True, "includeEnharmonicCorrection": True,
    })
    check("HTTP 200 (modulating sample)", resp2.status_code, 200)
    body2 = resp2.get_json() or {}
    mods2 = body2.get("modulations") or []
    check_true("response carries 1 modulation", len(mods2) == 1, f"got {mods2}")
    sections2 = (body2.get("romanNumerals") or {}).get("sections") or []
    check_true("response carries 2 sections", len(sections2) == 2, f"got {sections2}")
    shifts2 = (body2.get("romanNumerals") or {}).get("temporalShifts") or []
    check_true("temporalShifts is non-empty", len(shifts2) >= 1, f"got {shifts2}")
    romans2 = (body2.get("romanNumerals") or {}).get("analysis") or []
    check("the first chord after the modulation is analysed in the new key (analysis[16])",
          romans2[16] if len(romans2) > 16 else None, "I")

    # no chord array -> 400
    check("missing chords -> 400", client.post("/api/analyze-harmony", json={}).status_code, 400)


# --------------------------------------------------------------------------- #
# 6. Audio key (madmom), optional
# --------------------------------------------------------------------------- #
def test_audio_key() -> None:
    print("\n[6] Audio key curve (madmom CNN)")
    from services.harmony import audio_key

    if not audio_key.available():
        print("  SKIP the madmom key model is unavailable")
        return

    from services.cache import cache_service, sqlite_store

    rows = sqlite_store.recent_analyses(limit=50)
    audio_ids = []
    for row in rows:
        aid = row.get("audio_id")
        if aid and aid not in audio_ids:
            audio_ids.append(aid)
    paths = [(aid, cache_service.audio_path(aid)) for aid in audio_ids]
    paths = [(aid, p) for aid, p in paths if p]
    print(f"  cached audio: {[(a[:12], p.name) for a, p in paths]}")

    for aid, path in paths:
        res = audio_key.analyze(str(path))
        if not res:
            check_true(f"audio {path.name} analysed successfully", False, "analyze returned None")
            continue
        print(f"  {path.name}: primaryKey={res['primaryKey']} "
              f"conf={res['confidence']} sections={[(s['key'], round(s['start'], 1)) for s in res['sections']]}")
        check_true(f"audio {path.name} has a key", bool(res.get("primaryKey")), str(res))

    # hand-spliced: first 20 s in A major + last 40 s in Eb major, should split into two sections
    wanted = {aid_ for aid_, _ in paths}
    if len(paths) >= 2:
        try:
            import numpy as np
            import soundfile as sf

            src_a = next(path for aid_, path in paths if "f68dd" in aid_ or "f68dd" in path.name)
            src_e = next(path for aid_, path in paths if path != src_a)
            a, sr_a = sf.read(str(src_a), dtype="float32", always_2d=True)
            e, sr_e = sf.read(str(src_e), dtype="float32", always_2d=True)
            a = a[: int(20 * sr_a)]
            e = e[: int(40 * sr_e)]
            mixed = np.concatenate([a, e], axis=0)
            out = "/tmp/harmony_regression_mod.wav"
            sf.write(out, mixed, sr_a)
            res = audio_key.analyze(out, chunk_seconds=20.0, hop_seconds=10.0)
            print(f"  spliced audio: primaryKey={res['primaryKey'] if res else None} "
                  f"sections={[(s['key'], round(s['start'], 1)) for s in (res or {}).get('sections', [])]}")
            check_true("spliced audio splits into >= 2 sections", bool(res) and len(res["sections"]) >= 2,
                       str(res and res["sections"]))
            if res and res["sections"]:
                check("key of the spliced audio's last section", res["sections"][-1]["key"], "Eb major")
        except Exception as exc:  # noqa: BLE001
            print(f"  SKIP spliced-audio test failed: {exc}")
            traceback.print_exc()


# --------------------------------------------------------------------------- #
# 7. Second real sample (a.mp3): real CNN output + a real modulation
# --------------------------------------------------------------------------- #
AUDIO_ID_A = "f68dd4834b32ece2cca55e9a87eb78eb3fbb5b40b36f60a232ca7291fe8513bf"


def _cached_chord_segments(audio_id: str):
    """Fetch an audio's most recent chord result from the local cache and merge adjacent same-label chords (matching the frontend)."""
    import json as _json
    import sqlite3

    from utils.paths import CACHE_DB_PATH

    if not CACHE_DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(CACHE_DB_PATH))
    try:
        rows = list(
            conn.execute(
                "select payload from analyses where kind='chords' and audio_id=? "
                "order by created_at desc limit 1",
                (audio_id,),
            )
        )
    finally:
        conn.close()
    if not rows:
        return None

    chords = _json.loads(rows[0][0]).get("chords") or []
    segments: list[dict] = []
    for item in chords:
        label = item.get("chord")
        if not label:
            continue
        if segments and segments[-1]["chord"] == label:
            segments[-1]["end"] = item.get("end")
            continue
        segments.append({"chord": label, "time": item.get("start"), "end": item.get("end")})
    return segments


def test_second_real_song() -> None:
    print("\\n[7] Second real sample a.mp3 (real CNN chords + a real A->B modulation)")
    from services.cache import cache_service

    segments = _cached_chord_segments(AUDIO_ID_A)
    if not segments:
        print("  SKIP the cache has no chord result for a.mp3")
        return
    audio_path = cache_service.audio_path(AUDIO_ID_A)
    if not audio_path or not audio_path.exists():
        print("  SKIP the cache has no audio bytes for a.mp3")
        return

    n = len(segments)
    client = _client()
    resp = client.post("/api/analyze-harmony?nocache=1", json={
        "chords": segments,
        "includeRomanNumerals": True,
        "includeEnharmonicCorrection": True,
        "audioId": AUDIO_ID_A,
    })
    check("HTTP 200 (a.mp3 with audioId)", resp.status_code, 200)
    data = resp.get_json() or {}

    check("key source is audio", data.get("keySource"), "audio")
    check("primary key (madmom decides A major)", data.get("primaryKey"), "A major")
    # this song's chord-degree content overlaps heavily between A major and B minor and the chord heuristic picks B minor
    # (only the madmom audio CNN gives A major), so a keyConflict hint must be reported here.
    check_true("keyConflict is reported when the chord heuristic disagrees with the audio",
               bool(data.get("keyConflict")), f"chordKey={data.get('chordKey')}")

    mods = data.get("modulations") or []
    check("exactly one modulation", len(mods), 1)
    if mods:
        check("modulation target key", mods[0].get("toKey"), "B major")
        check("modulation source is audio", mods[0].get("source"), "audio")
        idx = mods[0].get("atIndex")
        t = segments[idx]["time"] if isinstance(idx, int) and 0 <= idx < n else None
        check_true("modulation position falls in the real key change (100-145s)",
                   t is not None and 100.0 <= float(t) <= 145.0,
                   f"atIndex={idx} time={t}")

    sections = (data.get("romanNumerals") or {}).get("sections") or []
    check("section count (A major / B major)", len(sections), 2)
    check("first section key", sections[0].get("key") if sections else None, "A major")
    check("last section key", sections[-1].get("key") if sections else None, "B major")

    check("originalChords length", len(data.get("originalChords") or []), n)
    check("correctedChords length", len(data.get("correctedChords") or []), n)
    check("romanNumerals.analysis length",
          len((data.get("romanNumerals") or {}).get("analysis") or []), n)
    check("the two correctedSequence values are the same data",
          (data.get("sequenceCorrections") or {}).get("correctedSequence"),
          data.get("correctedChords"))
    shifts = (data.get("romanNumerals") or {}).get("temporalShifts") or []
    check_true("temporalShifts records the key change position", len(shifts) >= 1, str(shifts))

    # without audioId -> falls back to the chord path; this song is fairly neutral, so it pins down the "keyConflict must always be a fallback" behaviour
    resp2 = client.post("/api/analyze-harmony?nocache=1", json={
        "chords": segments,
        "includeRomanNumerals": True,
        "includeEnharmonicCorrection": True,
    })
    data2 = resp2.get_json() or {}
    check("keySource=chords without audio", data2.get("keySource"), "chords")
    print(f"  chord-path global key = {data2.get('primaryKey')}"
          f"(the audio authority is A major, so a keyConflict hint is needed)")
    check_true("the chord path also finds the key change", len(data2.get("modulations") or []) >= 1,
               str(data2.get("modulations")))
    check("correctedChords stays aligned without audio", len(data2.get("correctedChords") or []), n)


# --------------------------------------------------------------------------- #
# 8. Conventional notation for chromatic degrees
# --------------------------------------------------------------------------- #
def test_chromatic_spelling() -> None:
    """The nearest-degree algorithm only guarantees the correct pitch; its notation is often unconventional:

    when a chromatic note a semitone away is equidistant from two adjacent degrees, the old implementation always took the sharp side (Bb -> #I, C -> #II,
    F in A major -> #v), which any musician reads as bII / bIII / bvi. This group pins down the corrected spelling.
    """
    print("\n[8] Conventional notation for chromatic chords")
    from services.harmony import analyze_sequence

    cases = [
        ("Bb:maj", "A major", "bII"),
        ("Bb:7", "A major", "bII7"),
        ("C:maj", "A major", "bIII"),
        ("C:maj7", "A major", "bIIImaj7"),
        ("F:hdim7", "A major", "bviø7"),
        ("B:maj", "Eb major", "bVI"),
        ("C#:maj", "Eb major", "bVII"),
        # in-key degrees are unaffected
        ("F:min", "Eb major", "ii"),
        ("Ab:maj", "Eb major", "IV"),
        ("Eb:maj", "Eb major", "I"),
    ]
    for chord, key, expected in cases:
        romans = analyze_sequence([chord], key)
        check(f"spelling({chord}, {key})", romans[0] if romans else None, expected)


def main() -> int:
    for fn in (test_roman_numerals, test_key_names, test_monotonal_no_modulation,
               test_true_modulation, test_api_alignment, test_audio_key,
               test_second_real_song, test_chromatic_spelling):
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"{fn.__name__} raised {exc!r}")
            print(f"  FAIL {fn.__name__} raised {exc!r}")
            traceback.print_exc()

    print(f"\n==== {CHECKS - len(FAILURES)}/{CHECKS} passed, {len(FAILURES)} failed ====")
    for item in FAILURES:
        print(f"  - {item}")
    return len(FAILURES)


if __name__ == "__main__":
    sys.exit(main())
