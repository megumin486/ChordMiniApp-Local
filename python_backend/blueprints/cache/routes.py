"""Local cache blueprint: /api/cache/* and /api/audio/*

Design points:
- all data lives in the machine-local SQLite (``data/chordmini_cache.db``) and
  ``data/audio/<sha[:2]>/<sha><ext>``; no cloud service is used.
- audio is content-addressed (sha256), so uploading the same file twice occupies one copy.
- analyses are cached by (kind, audio content, model, parameters) or (kind, model, input JSON),
  and a hit returns ``fromCache: true``.
"""
from __future__ import annotations

import mimetypes
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from services.cache import cache_service, sqlite_store
from utils.logging import log_error, log_info

cache_bp = Blueprint("cache", __name__)

_EXT_MIMETYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
}


def _mimetype_for(path: Path, ext: str | None = None) -> str:
    key = (ext or path.suffix).lower()
    if key in _EXT_MIMETYPES:
        return _EXT_MIMETYPES[key]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def _as_int(value, default: int, minimum: int = 1, maximum: int = 200) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


# --------------------------------------------------------------------------- #
# Stats / maintenance
# --------------------------------------------------------------------------- #
@cache_bp.route("/api/cache/stats", methods=["GET"])
def cache_stats():
    """Cache usage and entry counts, for the frontend settings page."""
    try:
        return jsonify({"success": True, **cache_service.stats()})
    except Exception as exc:
        log_error(f"Cache stats failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


@cache_bp.route("/api/cache/clear", methods=["POST"])
def cache_clear():
    """Clear the whole local cache: analyses + kv_cache + audio bytes and registry.

    There used to be ``/api/cache/maintenance`` (reclaim by a 30-day TTL / 2048MB LRU budget),
    but it only reclaimed rows that were already due, which is always 0 in normal use, so clicking "clean" showed no change.
    Phase 5 removed it: expiry reclaim now runs at process start inside ``cache_service.ensure_ready()``,
    so the only user-visible entry left is this unconditional clear.
    """
    try:
        return jsonify({"success": True, **cache_service.clear_all()})
    except Exception as exc:
        log_error(f"Cache clear failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


@cache_bp.route("/api/cache/restore", methods=["GET"])
def cache_restore():
    """Rebuild one analysis from the cache (the "open last analysis" entry point).

    Query parameter: ``audioId`` picks a specific track; by default the most recent reopenable analysis is used.
    The response shape matches the combination of ``/api/recognize-chords`` and ``/api/detect-beats``,
    so the frontend can render the grid directly without running the models again.
    """
    audio_id = (request.args.get("audioId") or "").strip()
    try:
        result = (
            cache_service.restore_audio_analysis(audio_id)
            if audio_id
            else cache_service.latest_analysis()
        )
        if not result:
            return jsonify(
                {"success": False, "error": "no cached analysis available"}
            ), 404
        return jsonify(result)
    except Exception as exc:
        log_error(f"Cache restore failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


@cache_bp.route("/api/cache/recent", methods=["GET"])
def cache_recent():
    """Recent analyses (newest first, folded by audio_id).

    Query parameters:
      limit  default 20, maximum 100
      offset row offset after folding (for paging), default 0
      key    key-signature filter, e.g. ``A major``; no filter by default
    """
    try:
        limit = _as_int(request.args.get("limit"), 20)
        try:
            offset = max(0, int(request.args.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        key = (request.args.get("key") or "").strip() or None
        if key == "all":
            key = None
        items = cache_service.recent(limit, offset=offset, key_signature=key)
        return jsonify({"success": True, "items": items, "total": len(items)})
    except Exception as exc:
        log_error(f"Cache recent failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


# --------------------------------------------------------------------------- #
# Key/value (lightweight caches such as detect-key)
# --------------------------------------------------------------------------- #
@cache_bp.route("/api/cache/kv", methods=["GET"])
def cache_kv_get():
    """Read one key/value cache entry; when missing it returns ``found: false`` (not a 404)."""
    key = (request.args.get("key") or "").strip()
    if not key:
        return jsonify({"success": False, "error": "key is required"}), 400
    try:
        value = cache_service.kv_get(key)
        return jsonify({"success": True, "found": value is not None, "value": value})
    except Exception as exc:
        log_error(f"Cache kv get failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


@cache_bp.route("/api/cache/kv", methods=["POST"])
def cache_kv_set():
    """Write one key/value cache entry. When ``ttlSeconds`` is omitted the global TTL is used."""
    payload = request.get_json(silent=True) or {}
    key = str(payload.get("key") or "").strip()
    if not key:
        return jsonify({"success": False, "error": "key is required"}), 400
    if "value" not in payload:
        return jsonify({"success": False, "error": "value is required"}), 400
    try:
        ttl = payload.get("ttlSeconds")
        ttl_seconds = float(ttl) if ttl is not None else None
        stored = cache_service.kv_set(key, payload["value"], ttl_seconds)
        return jsonify({"success": bool(stored), "key": key})
    except Exception as exc:
        log_error(f"Cache kv set failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


@cache_bp.route("/api/cache/analysis-key", methods=["POST"])
def cache_analysis_key():
    """Write a key signature back onto an audio's analysis row.

    detect-key and chord recognition are two independent requests and the key result arrives after the chords row; the home page's "recent"
    list reads the analyses table directly, so this endpoint provides an explicit write-back channel.

    Request body: ``{"audioId": "...", "keySignature": "A major"}``
    """
    payload = request.get_json(silent=True) or {}
    audio_id = str(payload.get("audioId") or "").strip()
    key_signature = str(payload.get("keySignature") or "").strip()
    if not audio_id or not key_signature:
        return jsonify({"success": False, "error": "audioId and keySignature are required"}), 400
    try:
        updated = cache_service.set_audio_key(audio_id, key_signature)
        return jsonify({"success": True, "updated": updated})
    except Exception as exc:
        log_error(f"Cache analysis-key failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


@cache_bp.route("/api/cache/kv", methods=["DELETE"])
def cache_kv_delete():
    """Delete key/value cache entries in bulk."""
    payload = request.get_json(silent=True) or {}
    keys = payload.get("keys")
    if not isinstance(keys, list) or not keys:
        return jsonify({"success": False, "error": "keys must be a non-empty list"}), 400
    try:
        deleted = cache_service.kv_delete([str(k) for k in keys])
        return jsonify({"success": True, "deleted": deleted})
    except Exception as exc:
        log_error(f"Cache kv delete failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


# --------------------------------------------------------------------------- #
# Audio store
# --------------------------------------------------------------------------- #
@cache_bp.route("/api/audio/store", methods=["POST"])
def audio_store_upload():
    """Store the uploaded audio in the local content-addressed store.

    Multipart field: ``file``. Response: ``audioId / size / duplicated / audioUrl``.
    """
    if "file" not in request.files:
        return jsonify({"success": False, "error": "file is required"}), 400
    upload = request.files["file"]
    if not upload.filename:
        return jsonify({"success": False, "error": "empty filename"}), 400
    temp_path = None
    try:
        # land in a temp file on the same volume first, then let audio_store archive it under its sha256 name (avoids doubling memory)
        import tempfile

        suffix = Path(upload.filename).suffix or ".mp3"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            upload.save(temp_path)
        info = cache_service.ingest_audio(temp_path, upload.filename)
        if not info:
            return jsonify({"success": False, "error": "could not store audio"}), 500
        log_info(
            f"Audio stored: {info.get('audio_id', '')[:12]} "
            f"({info.get('size', 0) / 1024 / 1024:.1f} MB, duplicated={info.get('duplicated')})"
        )
        return jsonify(
            {
                "success": True,
                "audioId": info["audio_id"],
                "size": info["size"],
                "ext": info["ext"],
                "duplicated": info["duplicated"],
                "audioUrl": f"/api/audio/{info['audio_id']}",
            }
        )
    except Exception as exc:
        log_error(f"Audio store failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500
    finally:
        if temp_path:
            try:
                Path(temp_path).unlink(missing_ok=True)
            except OSError:
                pass


@cache_bp.route("/api/audio/<audio_id>", methods=["GET"])
def audio_serve(audio_id: str):
    """Serve local audio by audioId (Range is supported, so an <audio> element can scrub)."""
    if not audio_id or len(audio_id) > 128:
        return jsonify({"success": False, "error": "invalid audio id"}), 400
    try:
        entry = sqlite_store.audio_get(audio_id)
        path = cache_service.audio_path(audio_id)
        if not path or not path.is_file():
            return jsonify({"success": False, "error": "audio not found"}), 404
        ext = entry.get("ext") if entry else path.suffix
        response = send_file(
            path,
            mimetype=_mimetype_for(path, ext),
            conditional=True,
            download_name=(entry or {}).get("filename") or path.name,
        )
        response.headers["Accept-Ranges"] = "bytes"
        response.headers["Cache-Control"] = "private, max-age=86400"
        return response
    except Exception as exc:
        log_error(f"Audio serve failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


@cache_bp.route("/api/audio/<audio_id>", methods=["DELETE"])
def audio_delete(audio_id: str):
    """Delete one audio: bytes + registry row + all analysis rows for that audio."""
    if not audio_id or len(audio_id) > 128:
        return jsonify({"success": False, "error": "invalid audio id"}), 400
    try:
        result = cache_service.delete_audio(audio_id)
        if not result.get("success"):
            return jsonify(result), 400
        log_info(
            f"Audio deleted: {audio_id[:12]} "
            f"({result.get('freedBytes', 0) / 1024 / 1024:.1f} MB, "
            f"{result.get('removedAnalyses', 0)} analysis row(s))"
        )
        return jsonify(result)
    except Exception as exc:
        log_error(f"Audio delete failed: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500