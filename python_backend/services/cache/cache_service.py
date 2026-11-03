"""High-level cache API used by the blueprints.

Keeps the route handlers free of storage details:

    from services.cache import cache_service

    hit = cache_service.lookup_analysis('chords', audio_id, model, params)
    if hit:
        return jsonify(cache_service.replay(hit['payload'], hit))

Cache keys are content-addressed: ``sha256(audio bytes)`` for audio-derived
work, and a hash over the normalised request parameters for the rest. That means
re-uploading the same file — even renamed — hits the cache, while a different
model or chord dictionary does not.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from utils.logging import log_debug, log_info
from utils.paths import AUDIO_STORE_DIR, CACHE_DB_PATH, CACHE_TTL_DAYS

from . import audio_store, sqlite_store

_KEY_VERSION = "v1"
_ready = False


def ensure_ready() -> None:
    """Create tables and, once at process start, run TTL reclaim and audio budget eviction.

    These two used to be triggered by the ``/api/cache/maintenance`` button; after the button was removed they moved here,
    so the "expired entries do get cleaned up" semantics is preserved, it just no longer needs a user-visible entry point.
    """
    global _ready
    if _ready:
        return
    sqlite_store.init_db()
    purged_kv = sqlite_store.kv_purge_expired()
    purged_analyses = sqlite_store.purge_expired_analyses()
    eviction = audio_store.evict_to_limit()
    if purged_kv or purged_analyses or eviction.get("evicted_files"):
        log_info(
            "Startup cache maintenance: "
            f"kv={purged_kv} analyses={purged_analyses} "
            f"audioFiles={eviction.get('evicted_files', 0)} "
            f"freed={eviction.get('freed', 0) / 1024 / 1024:.1f} MB"
        )
    _ready = True


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #
def _normalize_params(params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not params:
        return {}
    normalized: Dict[str, Any] = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            normalized[key] = value
        else:
            normalized[key] = str(value).strip()
    return normalized


def make_analysis_key(
    kind: str,
    audio_id: str,
    model: Optional[str] = None,
    params: Optional[Dict[str, Any]] = None,
) -> str:
    payload = json.dumps(
        {
            "v": _KEY_VERSION,
            "kind": kind,
            "audio": audio_id,
            "model": model or "",
            "params": _normalize_params(params),
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:40]


def make_input_key(kind: str, model: Optional[str], payload: Any) -> str:
    """Key for work derived from a JSON request body (harmony, segmentation...)."""
    blob = json.dumps(
        {"v": _KEY_VERSION, "kind": kind, "model": model or "", "input": payload},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:40]


# --------------------------------------------------------------------------- #
# Audio
# --------------------------------------------------------------------------- #
def ingest_audio(src_path: str | Path, filename: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Persist an uploaded file into the local audio store. Never raises."""
    try:
        info = audio_store.ingest(src_path, filename)
        audio_store.evict_to_limit()
        return info
    except Exception as exc:  # storage must never break analysis
        log_debug(f"Audio ingest skipped ({exc})")
        return None


def audio_path(audio_id: str) -> Optional[Path]:
    return audio_store.resolve(audio_id)


def delete_audio(audio_id: str) -> Dict[str, Any]:
    """User explicitly deletes one track: audio bytes + every analysis row for that audio.

    Unlike the LRU eviction in ``maintenance()`` -- that reclaims by budget passively, whereas here the user
    clicks delete in the "recent" list, so the analysis rows are cleared too and it no longer shows up there.
    """
    if not audio_id:
        return {"success": False, "error": "audioId is required"}
    ensure_ready()
    audio_result = audio_store.delete(audio_id)
    removed_analyses = sqlite_store.analysis_forget_audio(audio_id)
    return {
        "success": True,
        "audioId": audio_id,
        "removedFile": audio_result.get("removed_file", False),
        "freedBytes": audio_result.get("freed_bytes", 0),
        "removedAnalyses": removed_analyses,
    }


def clear_all() -> Dict[str, Any]:
    """Clear the whole local cache: analyses + kv_cache + audio bytes and registry."""
    ensure_ready()
    removed_analyses = sqlite_store.analyses_clear()
    removed_kv = sqlite_store.kv_clear()
    audio_result = audio_store.clear_all()
    result = {
        "removedAnalyses": removed_analyses,
        "removedKvEntries": removed_kv,
        "removedAudioFiles": audio_result.get("deleted_files", 0),
        "removedAudioRows": audio_result.get("removed_rows", 0),
        "freedBytes": audio_result.get("freed_bytes", 0),
    }
    log_info(f"Local cache cleared: {result}")
    return result


# --------------------------------------------------------------------------- #
# Analysis cache
# --------------------------------------------------------------------------- #
def restore_audio_analysis(audio_id: str) -> Optional[Dict[str, Any]]:
    """Assemble an audio's cached analysis into a structure the frontend can rebuild the page from directly.

    Returns ``{audioId, audioUrl, filename, duration, chords, beats, harmony,
    beatModel, chordModel, createdAt}``; returns None when there is no usable chord or beat cache
    (the caller falls back to "please analyze again").
    """
    if not audio_id:
        return None
    ensure_ready()
    path = audio_store.resolve(audio_id)
    if not path:
        return None

    rows = sqlite_store.analysis_payloads_for_audio(audio_id)
    if not rows:
        return None

    chords_row = next((r for r in rows if r["kind"] == "chords"), None)
    beats_row = next((r for r in rows if r["kind"] == "beats"), None)
    harmony_row = next((r for r in rows if r["kind"] == "harmony"), None)

    chords_payload = (chords_row or {}).get("payload") or {}
    beats_payload = (beats_row or {}).get("payload") or {}
    if not chords_payload.get("chords") or not beats_payload.get("beats"):
        return None

    entry = sqlite_store.audio_get(audio_id) or {}
    return {
        "success": True,
        "audioId": audio_id,
        "audioUrl": f"/api/audio/{audio_id}",
        "filename": entry.get("filename") or (chords_row or {}).get("filename"),
        "duration": entry.get("duration")
        or chords_payload.get("duration")
        or beats_payload.get("duration"),
        "chords": chords_payload.get("chords") or [],
        "beats": beats_payload.get("beats") or [],
        "downbeats": beats_payload.get("downbeats") or [],
        "bpm": beats_payload.get("bpm"),
        "timeSignature": beats_payload.get("time_signature"),
        "beatModel": (beats_row or {}).get("model"),
        "chordModel": (chords_row or {}).get("model"),
        "harmony": (harmony_row or {}).get("payload"),
        "createdAt": (chords_row or {}).get("created_at"),
    }


def latest_analysis() -> Optional[Dict[str, Any]]:
    """The most recent reopenable analysis (used by the "open last analysis" entry point)."""
    ensure_ready()
    items = recent(limit=1)
    if not items:
        return None
    return restore_audio_analysis(items[0]["audio_id"])


def lookup_analysis(
    kind: str,
    audio_id: Optional[str] = None,
    model: Optional[str] = None,
    params: Optional[Dict[str, Any]] = None,
    input_payload: Any = None,
) -> Optional[Dict[str, Any]]:
    """Return the cached entry (``{payload, created_at, hits, ...}``) or None."""
    ensure_ready()
    if audio_id:
        key = make_analysis_key(kind, audio_id, model, params)
    elif input_payload is not None:
        key = make_input_key(kind, model, input_payload)
    else:
        return None
    return sqlite_store.analysis_get(key)


def _extract_analysis_meta(payload: Any) -> Dict[str, Any]:
    """Pull the fields the "recent" list needs out of an analysis result (missing means None).

    Chord results put time signature/BPM in ``beatDetectionResult``; harmony results put the key in
    ``primaryKey``. Both shapes are handled here so each route does not write its own copy.
    """
    meta: Dict[str, Any] = {"key_signature": None, "bpm": None, "time_signature": None}
    if not isinstance(payload, dict):
        return meta

    key = payload.get("keySignature") or payload.get("primaryKey") or payload.get("key")
    if isinstance(key, str) and key.strip():
        meta["key_signature"] = key.strip()

    beat = payload.get("beatDetectionResult")
    if not isinstance(beat, dict):
        beat = {}

    bpm = payload.get("bpm", beat.get("bpm"))
    if isinstance(bpm, (int, float)) and bpm > 0:
        meta["bpm"] = float(bpm)

    time_signature = payload.get("timeSignature", beat.get("time_signature"))
    if isinstance(time_signature, (int, float)) and int(time_signature) > 0:
        meta["time_signature"] = int(time_signature)

    return meta


def store_analysis(
    kind: str,
    payload: Any,
    audio_id: Optional[str] = None,
    model: Optional[str] = None,
    params: Optional[Dict[str, Any]] = None,
    input_payload: Any = None,
    duration: Optional[float] = None,
    filename: Optional[str] = None,
) -> None:
    """Record a fresh analysis result. Never raises."""
    ensure_ready()
    try:
        if audio_id:
            key = make_analysis_key(kind, audio_id, model, params)
        elif input_payload is not None:
            key = make_input_key(kind, model, input_payload)
        else:
            return
        meta = _extract_analysis_meta(payload)
        sqlite_store.analysis_put(
            cache_key=key,
            kind=kind,
            payload=payload,
            audio_id=audio_id,
            model=model,
            params=_normalize_params(params),
            duration=duration,
            filename=filename,
            key_signature=meta["key_signature"],
            bpm=meta["bpm"],
            time_signature=meta["time_signature"],
        )
        if audio_id and duration:
            sqlite_store.audio_set_duration(audio_id, duration)
    except Exception as exc:
        log_debug(f"Analysis cache store skipped ({exc})")


def set_audio_key(audio_id: Optional[str], key_signature: Optional[str]) -> int:
    """Write the key signature onto the audio's existing analysis rows (detect-key usually runs after chord recognition).

    Returns the number of updated rows; 0 when there is no audio_id or key.
    """
    if not audio_id or not key_signature:
        return 0
    try:
        ensure_ready()
        return sqlite_store.analysis_set_key(audio_id, key_signature)
    except Exception as exc:  # pragma: no cover - defensive
        log_debug(f"Analysis key backfill skipped ({exc})")
        return 0


def replay(payload: Any, entry: Optional[Dict[str, Any]] = None) -> Any:
    """Decorate a cached payload so the client can tell it came from the cache."""
    if not isinstance(payload, dict):
        return payload
    decorated = dict(payload)
    original_processing_time = decorated.get("processing_time")
    decorated["fromCache"] = True
    decorated["cacheHit"] = True
    if entry:
        decorated["cachedAt"] = entry.get("created_at")
        decorated["cacheHits"] = entry.get("hits")
    if original_processing_time is not None:
        decorated["original_processing_time"] = original_processing_time
        decorated["processing_time"] = 0
    return decorated


# --------------------------------------------------------------------------- #
# Key/value passthrough
# --------------------------------------------------------------------------- #
def kv_get(key: str) -> Any:
    ensure_ready()
    return sqlite_store.kv_get(key)


def kv_set(key: str, value: Any, ttl_seconds: Optional[float] = None) -> bool:
    ensure_ready()
    return sqlite_store.kv_set(key, value, ttl_seconds)


def kv_delete(keys: list[str]) -> int:
    ensure_ready()
    return sqlite_store.kv_delete(keys)


# --------------------------------------------------------------------------- #
# Recent list / stats / maintenance
# --------------------------------------------------------------------------- #
def recent(
    limit: int = 20,
    offset: int = 0,
    key_signature: Optional[str] = None,
) -> list[Dict[str, Any]]:
    """Recent analyses, newest first, with a playback URL when bytes exist.

    One audio produces several rows (chords / harmony / beats); here they are folded by audio_id into
    one, merging each row's key / BPM / time signature -- the list is a list of "tracks", not of "cache
    rows". Paging happens on the folded sequence, so more raw rows are fetched up front.
    """
    ensure_ready()
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    # folding drops rows, so fetch with 3x redundancy (at most 3 analysis kinds per track), then truncate
    raw = sqlite_store.recent_analyses(
        limit=(offset + limit) * 3,
        key_signature=key_signature,
    )

    merged: Dict[str, Dict[str, Any]] = {}
    order: list[str] = []
    for item in raw:
        # rows without an audio_id (e.g. a harmony result computed straight from input chords) cannot be tied to
        # a specific track, so they can neither be played nor deduplicated -- they are not shown in the list.
        if not item.get("audio_id"):
            continue
        bucket = item["audio_id"]
        if bucket not in merged:
            merged[bucket] = dict(item)
            order.append(bucket)
            continue
        current = merged[bucket]
        for field in ("key_signature", "bpm", "time_signature", "duration", "filename"):
            if current.get(field) in (None, "") and item.get(field) not in (None, ""):
                current[field] = item[field]

    items = [merged[bucket] for bucket in order][offset:offset + limit]

    for item in items:
        audio_id = item.get("audio_id")
        if audio_id and audio_store.resolve(audio_id):
            item["audioUrl"] = f"/api/audio/{audio_id}"
        else:
            item["audioUrl"] = None
        item["title"] = item.get("filename") or (audio_id[:12] if audio_id else "unknown")
        item["keySignature"] = item.get("key_signature")
        item["timeSignature"] = item.get("time_signature")
    return items


def stats() -> Dict[str, Any]:
    ensure_ready()
    db_bytes = 0
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(CACHE_DB_PATH) + suffix)
        if candidate.is_file():
            db_bytes += candidate.stat().st_size
    return {
        "dbPath": str(CACHE_DB_PATH),
        "dbBytes": db_bytes,
        "analyses": sqlite_store.analysis_count(),
        "audio": audio_store.stats(),
        "ttlDays": CACHE_TTL_DAYS,
    }


def maintenance() -> Dict[str, Any]:
    """Reclaim by policy: drop expired KV / expired analyses and evict audio down to the budget.

    The frontend no longer exposes this entry (the user wants "clear everything"). The TTL and LRU budget now run
    once at process start inside ``ensure_ready()``, same semantics but no button needed.
    """
    ensure_ready()
    purged_kv = sqlite_store.kv_purge_expired()
    purged_analyses = sqlite_store.purge_expired_analyses()
    eviction = audio_store.evict_to_limit()
    result = {
        "purgedKvEntries": purged_kv,
        "purgedAnalyses": purged_analyses,
        "evictedFiles": eviction.get("evicted_files", 0),
        "evictedBytes": eviction.get("evicted_bytes", 0),
        "audioBytes": eviction.get("bytes", 0),
    }
    log_info(f"Cache maintenance: {result}")
    return result