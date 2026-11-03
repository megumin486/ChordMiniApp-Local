"""Content-addressed audio store with an LRU budget.

The upstream project kept analysed audio in Firebase Storage and handed the
player a signed download URL. Here the bytes live on local disk, addressed by
the SHA-256 of their content: uploading the same file twice stores it once and
the analysis cache key derived from that hash stays valid.

Layout::

    <AUDIO_STORE_DIR>/<first two hex chars>/<sha256><ext>

Eviction is by least-recently-used row in ``audio_files`` (see
:mod:`services.cache.sqlite_store`), triggered after every ingest and by the
explicit maintenance endpoint. Deleting the bytes does NOT invalidate cached
analyses: an analysis is keyed on the hash, not on the file.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from utils.logging import log_debug, log_error, log_info
from utils.paths import AUDIO_STORE_DIR, AUDIO_STORE_MAX_BYTES

from . import sqlite_store

_ALLOWED_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".opus", ".webm", ".ogg", ".aiff", ".aif"}
_DEFAULT_EXT = ".mp3"
_CHUNK = 1024 * 1024


def sha256_of_file(path: str | Path) -> str:
    """Streaming SHA-256 so a 100 MB upload does not land in memory twice."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_ext(filename: Optional[str]) -> str:
    if not filename:
        return _DEFAULT_EXT
    suffix = Path(filename).suffix.lower()
    return suffix if suffix in _ALLOWED_EXTS else _DEFAULT_EXT


def target_path(audio_id: str, ext: str) -> Path:
    return AUDIO_STORE_DIR / audio_id[:2] / f"{audio_id}{ext}"


def ingest(src_path: str | Path, filename: Optional[str] = None) -> Dict[str, Any]:
    """Copy ``src_path`` into the store (deduplicated) and register it.

    Returns ``{audio_id, ext, size, path, duplicated}``.
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"source audio not found: {src}")

    audio_id = sha256_of_file(src)
    ext = normalize_ext(filename or src.name)
    size = src.stat().st_size
    dest = target_path(audio_id, ext)

    duplicated = dest.exists()
    if not duplicated:
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Write next to the target then rename: a crash never leaves a partial
        # file under the final content-addressed name.
        fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), prefix=".ingest-")
        os.close(fd)
        try:
            shutil.copyfile(src, tmp_name)
            os.replace(tmp_name, dest)
        except Exception:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
            raise
        log_debug(f"Stored audio {audio_id[:12]}... ({size} bytes) at {dest}")
    else:
        log_debug(f"Audio {audio_id[:12]}... already stored, deduplicated")

    sqlite_store.audio_upsert(
        audio_id=audio_id,
        path=str(dest),
        size=size,
        ext=ext,
        filename=filename or src.name,
        sha256=audio_id,
    )
    sqlite_store.audio_touch(audio_id)

    return {
        "audio_id": audio_id,
        "ext": ext,
        "size": size,
        "path": str(dest),
        "duplicated": duplicated,
    }


def resolve(audio_id: str) -> Optional[Path]:
    """Return the on-disk path for ``audio_id`` if the bytes are still present."""
    if not audio_id or len(audio_id) < 8 or not all(c in "0123456789abcdef" for c in audio_id):
        return None
    row = sqlite_store.audio_get(audio_id)
    if row:
        path = Path(row["path"])
        if path.is_file():
            return path
        log_debug(f"Audio row {audio_id[:12]}... points at a missing file: {path}")
        return None
    # Row missing (e.g. DB reset) but bytes may still be there: look it up.
    for ext in _ALLOWED_EXTS:
        candidate = target_path(audio_id, ext)
        if candidate.is_file():
            return candidate
    return None


def total_bytes() -> int:
    return sqlite_store.audio_totals()["bytes"]


def evict_to_limit(max_bytes: int = 0) -> Dict[str, Any]:
    """Drop least-recently-used audio until the store fits the budget."""
    budget = max_bytes or AUDIO_STORE_MAX_BYTES
    totals = sqlite_store.audio_totals()
    current = totals["bytes"]
    if budget <= 0 or current <= budget:
        return {"evicted_files": 0, "evicted_bytes": 0, "freed": 0, "budget": budget, "bytes": current}

    evicted_ids: list[str] = []
    evicted_bytes = 0
    for row in sqlite_store.audio_lru(limit=10000):
        if current <= budget:
            break
        path = Path(row["path"])
        try:
            if path.is_file():
                path.unlink()
        except OSError as exc:  # pragma: no cover - defensive
            log_error(f"Failed to delete {path}: {exc}")
            continue
        current -= int(row["size"] or 0)
        evicted_bytes += int(row["size"] or 0)
        evicted_ids.append(row["audio_id"])

    if evicted_ids:
        sqlite_store.audio_forget(evicted_ids)
        log_info(
            f"Audio store eviction: removed {len(evicted_ids)} file(s), "
            f"{evicted_bytes / 1024 / 1024:.1f} MB freed, now {current / 1024 / 1024:.1f} MB"
        )

    return {
        "evicted_files": len(evicted_ids),
        "evicted_bytes": evicted_bytes,
        "freed": evicted_bytes,
        "budget": budget,
        "bytes": current,
    }


def stats() -> Dict[str, Any]:
    totals = sqlite_store.audio_totals()
    return {
        "files": totals["files"],
        "bytes": totals["bytes"],
        "megabytes": round(totals["bytes"] / 1024 / 1024, 2),
        "budget_bytes": AUDIO_STORE_MAX_BYTES,
        "budget_megabytes": round(AUDIO_STORE_MAX_BYTES / 1024 / 1024, 2),
        "directory": str(AUDIO_STORE_DIR),
    }


def delete(audio_id: str) -> Dict[str, Any]:
    """Delete one audio's bytes and its registry row.

    Unlike LRU eviction this is an explicit user delete: the registry row must go even if the file is gone, otherwise
    the "recent" list keeps an entry that cannot be opened.
    """
    if not audio_id:
        return {"deleted": False, "freed_bytes": 0}
    row = sqlite_store.audio_get(audio_id)
    freed = 0
    removed_file = False
    path = Path(row["path"]) if row and row.get("path") else None
    if path and path.is_file():
        try:
            freed = path.stat().st_size
            path.unlink()
            removed_file = True
        except OSError as exc:
            log_error(f"Failed to delete audio {audio_id[:12]}: {exc}")
            return {"deleted": False, "freed_bytes": 0}
    else:
        # registry row is gone but the bytes may remain: probe the allowed extensions
        for ext in _ALLOWED_EXTS:
            candidate = target_path(audio_id, ext)
            if candidate.is_file():
                try:
                    freed = candidate.stat().st_size
                    candidate.unlink()
                    removed_file = True
                except OSError:
                    pass
                break
    forgotten = sqlite_store.audio_forget([audio_id])
    return {
        "deleted": bool(removed_file or forgotten),
        "freed_bytes": freed,
        "removed_file": removed_file,
        "removed_row": bool(forgotten),
    }


def clear_all() -> Dict[str, Any]:
    """Clear the whole audio store (bytes + registry), returning the number of entries and bytes removed."""
    rows = sqlite_store.audio_lru(limit=100000)
    deleted_files = 0
    freed = 0
    for row in rows:
        path = Path(row["path"]) if row.get("path") else None
        if path and path.is_file():
            try:
                size = path.stat().st_size
                path.unlink()
                deleted_files += 1
                freed += size
            except OSError as exc:
                log_error(f"Failed to delete {path}: {exc}")
    # the path in the registry row may be stale, so sweep the shard directories as a fallback
    if AUDIO_STORE_DIR.is_dir():
        for shard in AUDIO_STORE_DIR.iterdir():
            if not shard.is_dir():
                continue
            for candidate in shard.iterdir():
                if candidate.is_file() and candidate.suffix.lower() in _ALLOWED_EXTS:
                    try:
                        freed += candidate.stat().st_size
                        candidate.unlink()
                        deleted_files += 1
                    except OSError:
                        pass
    removed_rows = sqlite_store.audio_clear()
    return {
        "deleted_files": deleted_files,
        "removed_rows": removed_rows,
        "freed_bytes": freed,
    }