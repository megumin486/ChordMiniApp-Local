"""SQLite store for the local cache.

Three logical tables:

``kv_cache``
    Generic key/value entries. Used by the Next.js ``/api/detect-key`` route,
    which previously kept its results in Firestore. Values are JSON text so the
    caller gets back exactly the structure it stored.

``audio_files``
    One row per distinct audio *content* (content-addressed by SHA-256). The
    bytes live in :mod:`services.cache.audio_store`; the row carries the LRU
    bookkeeping used by the eviction policy.

``analyses``
    Cached analysis payloads keyed by ``(kind, audio_id, model, params)``.
    ``kind`` is ``chords`` / ``beats`` / ``harmony``. ``payload`` is the exact
    JSON body the route returned the first time, so a cache hit replays the
    original response instead of re-running inference.

Concurrency: the Flask dev server is threaded and gunicorn runs 2 workers, so a
fresh connection is opened per operation (cheap for SQLite) with WAL mode and a
busy timeout. No connection is shared across threads.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from utils.logging import log_debug, log_error, log_info
from utils.paths import CACHE_DB_PATH, CACHE_TTL_DAYS, KV_CACHE_TTL_DAYS

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS kv_cache (
        key          TEXT PRIMARY KEY,
        value        TEXT NOT NULL,
        created_at   REAL NOT NULL,
        last_used_at REAL NOT NULL,
        expires_at   REAL,
        hits         INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS audio_files (
        audio_id     TEXT PRIMARY KEY,
        filename     TEXT,
        ext          TEXT,
        size         INTEGER NOT NULL,
        path         TEXT NOT NULL,
        sha256       TEXT,
        duration     REAL,
        created_at   REAL NOT NULL,
        last_used_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_audio_files_lru ON audio_files(last_used_at)",
    """
    CREATE TABLE IF NOT EXISTS analyses (
        cache_key    TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        audio_id     TEXT,
        model        TEXT,
        params       TEXT,
        payload      TEXT NOT NULL,
        duration     REAL,
        filename     TEXT,
        key_signature TEXT,
        bpm          REAL,
        time_signature INTEGER,
        created_at   REAL NOT NULL,
        last_used_at REAL NOT NULL,
        hits         INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_analyses_recent ON analyses(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_analyses_audio ON analyses(audio_id)",
)

_init_lock = threading.Lock()
_initialized_path: Optional[str] = None


def _now() -> float:
    return time.time()


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open a configured connection. Caller is responsible for closing it."""
    path = Path(db_path or CACHE_DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA foreign_keys=ON")
    except sqlite3.DatabaseError as exc:  # pragma: no cover - defensive
        log_error(f"Failed to pragma cache db {path}: {exc}")
    return conn


def _migrate_analysis_columns(conn: sqlite3.Connection) -> bool:
    """Add missing columns to an old analyses table (Phase 4 added key/BPM/time signature for the "recent" list).

    CREATE TABLE IF NOT EXISTS does not modify an existing table, so an old database must go through ALTER TABLE.
    Each column is checked separately and re-running is safe. Returns whether a column was really added this time -- the caller uses that to decide
    whether to backfill historical rows (it runs only when a column was added, avoiding a payload re-parse on every startup).
    """
    added = {
        "key_signature": "TEXT",
        "bpm": "REAL",
        "time_signature": "INTEGER",
    }
    try:
        existing = {
            row["name"] for row in conn.execute("PRAGMA table_info(analyses)").fetchall()
        }
    except sqlite3.DatabaseError as exc:  # pragma: no cover - defensive
        log_error(f"Failed to inspect analyses columns: {exc}")
        return False
    added_any = False
    for name, ddl in added.items():
        if name in existing:
            continue
        try:
            conn.execute(f"ALTER TABLE analyses ADD COLUMN {name} {ddl}")
            log_info(f"analyses: added column {name} {ddl}")
            added_any = True
        except sqlite3.DatabaseError as exc:  # pragma: no cover - defensive
            log_error(f"Failed to add analyses column {name}: {exc}")
    return added_any


def _backfill_analysis_meta(conn: sqlite3.Connection) -> int:
    """Fill in key/BPM/time signature for old rows from the payload JSON.

    Only rows where all three columns are empty are processed (newly written rows always fill in whatever they can); returns the number of updated rows.
    """
    try:
        rows = conn.execute(
            """
            SELECT cache_key, payload FROM analyses
            WHERE key_signature IS NULL AND bpm IS NULL AND time_signature IS NULL
            """
        ).fetchall()
    except sqlite3.DatabaseError as exc:  # pragma: no cover - defensive
        log_error(f"Backfill selection failed: {exc}")
        return 0

    updated = 0
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue

        key = payload.get("keySignature") or payload.get("primaryKey") or payload.get("key")
        beat = payload.get("beatDetectionResult")
        if not isinstance(beat, dict):
            beat = {}
        bpm = payload.get("bpm", beat.get("bpm"))
        time_signature = payload.get("timeSignature", beat.get("time_signature"))

        key_value = key.strip() if isinstance(key, str) and key.strip() else None
        bpm_value = float(bpm) if isinstance(bpm, (int, float)) and bpm > 0 else None
        ts_value = (
            int(time_signature)
            if isinstance(time_signature, (int, float)) and int(time_signature) > 0
            else None
        )
        if key_value is None and bpm_value is None and ts_value is None:
            continue

        try:
            conn.execute(
                """
                UPDATE analyses
                SET key_signature = ?, bpm = ?, time_signature = ?
                WHERE cache_key = ?
                """,
                (key_value, bpm_value, ts_value, row["cache_key"]),
            )
            updated += 1
        except sqlite3.DatabaseError as exc:  # pragma: no cover - defensive
            log_error(f"Backfill update failed: {exc}")
    if updated:
        log_info(f"analyses: backfilled key/bpm/time signature for {updated} cached rows")
    return updated


def init_db(db_path: Optional[Path] = None) -> Path:
    """Create the schema once per process. Idempotent and thread safe."""
    global _initialized_path
    path = Path(db_path or CACHE_DB_PATH)
    with _init_lock:
        if _initialized_path == str(path):
            return path
        conn = connect(path)
        try:
            for statement in _SCHEMA_STATEMENTS:
                conn.execute(statement)
            added_columns = _migrate_analysis_columns(conn)
            if added_columns:
                _backfill_analysis_meta(conn)
            conn.commit()
        finally:
            conn.close()
        _initialized_path = str(path)
        log_info(f"Local cache database ready: {path}")
        return path


def _db() -> sqlite3.Connection:
    init_db()
    return connect()


# --------------------------------------------------------------------------- #
# Key/value cache
# --------------------------------------------------------------------------- #
def kv_get(key: str) -> Optional[Any]:
    """Return the stored value, or None on miss/expiry. Counts as a hit."""
    conn = _db()
    try:
        row = conn.execute(
            "SELECT value, expires_at FROM kv_cache WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return None
        expires_at = row["expires_at"]
        if expires_at is not None and expires_at <= _now():
            conn.execute("DELETE FROM kv_cache WHERE key = ?", (key,))
            conn.commit()
            return None
        conn.execute(
            "UPDATE kv_cache SET last_used_at = ?, hits = hits + 1 WHERE key = ?",
            (_now(), key),
        )
        conn.commit()
        return json.loads(row["value"])
    except (sqlite3.DatabaseError, json.JSONDecodeError) as exc:
        log_error(f"kv_get failed for {key[:16]}...: {exc}")
        return None
    finally:
        conn.close()


def kv_set(key: str, value: Any, ttl_seconds: Optional[float] = None) -> bool:
    """Insert or replace an entry. ``ttl_seconds=None`` uses the configured KV TTL."""
    now = _now()
    if ttl_seconds is None:
        ttl_seconds = KV_CACHE_TTL_DAYS * 86400 if KV_CACHE_TTL_DAYS > 0 else 0
    expires_at = now + ttl_seconds if ttl_seconds and ttl_seconds > 0 else None
    conn = _db()
    try:
        conn.execute(
            """
            INSERT INTO kv_cache (key, value, created_at, last_used_at, expires_at, hits)
            VALUES (?, ?, ?, ?, ?, 0)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                last_used_at = excluded.last_used_at,
                expires_at = excluded.expires_at
            """,
            (key, json.dumps(value, ensure_ascii=False), now, now, expires_at),
        )
        conn.commit()
        return True
    except sqlite3.DatabaseError as exc:
        log_error(f"kv_set failed for {key[:16]}...: {exc}")
        return False
    finally:
        conn.close()


def kv_delete(keys: List[str]) -> int:
    if not keys:
        return 0
    conn = _db()
    try:
        deleted = 0
        for key in keys:
            cursor = conn.execute("DELETE FROM kv_cache WHERE key = ?", (key,))
            deleted += cursor.rowcount or 0
        conn.commit()
        return deleted
    except sqlite3.DatabaseError as exc:
        log_error(f"kv_delete failed: {exc}")
        return 0
    finally:
        conn.close()


def kv_clear() -> int:
    """Clear the kv_cache table; returns the number of deleted rows."""
    conn = _db()
    try:
        cursor = conn.execute("DELETE FROM kv_cache")
        conn.commit()
        return cursor.rowcount or 0
    except sqlite3.DatabaseError as exc:
        log_error(f"kv_clear failed: {exc}")
        return 0
    finally:
        conn.close()


def kv_purge_expired() -> int:
    conn = _db()
    try:
        cursor = conn.execute(
            "DELETE FROM kv_cache WHERE expires_at IS NOT NULL AND expires_at <= ?",
            (_now(),),
        )
        conn.commit()
        return cursor.rowcount or 0
    except sqlite3.DatabaseError as exc:
        log_error(f"kv_purge_expired failed: {exc}")
        return 0
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Analysis cache
# --------------------------------------------------------------------------- #
def analysis_payloads_for_audio(audio_id: str) -> List[Dict[str, Any]]:
    """Get all cache rows for one audio (read-only; does not bump hits).

    Used by "open last analysis": it fetches the chords / beats / harmony payloads in one go to rebuild
    the analysis page, so unlike ``analysis_get`` this cannot fetch by a single cache_key.
    """
    if not audio_id:
        return []
    conn = _db()
    try:
        rows = conn.execute(
            """
            SELECT cache_key, kind, model, params, payload, created_at, duration, filename
            FROM analyses WHERE audio_id = ? ORDER BY created_at DESC
            """,
            (audio_id,),
        ).fetchall()
        items: List[Dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except json.JSONDecodeError:
                continue
            items.append(
                {
                    "cache_key": row["cache_key"],
                    "kind": row["kind"],
                    "model": row["model"],
                    "params": row["params"],
                    "payload": payload,
                    "created_at": row["created_at"],
                    "duration": row["duration"],
                    "filename": row["filename"],
                }
            )
        return items
    except sqlite3.DatabaseError as exc:
        log_error(f"analysis_payloads_for_audio failed: {exc}")
        return []
    finally:
        conn.close()


def analysis_get(cache_key: str) -> Optional[Dict[str, Any]]:
    """Return ``{payload, created_at, hits, duration, filename}`` or None."""
    conn = _db()
    try:
        row = conn.execute(
            "SELECT payload, created_at, hits, duration, filename FROM analyses WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            "UPDATE analyses SET last_used_at = ?, hits = hits + 1 WHERE cache_key = ?",
            (_now(), cache_key),
        )
        conn.commit()
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            log_error("Cached analysis payload is not valid JSON; dropping entry")
            conn.execute("DELETE FROM analyses WHERE cache_key = ?", (cache_key,))
            conn.commit()
            return None
        return {
            "payload": payload,
            "created_at": row["created_at"],
            "hits": (row["hits"] or 0) + 1,
            "duration": row["duration"],
            "filename": row["filename"],
        }
    except sqlite3.DatabaseError as exc:
        log_error(f"analysis_get failed: {exc}")
        return None
    finally:
        conn.close()


def analysis_put(
    cache_key: str,
    kind: str,
    payload: Any,
    audio_id: Optional[str] = None,
    model: Optional[str] = None,
    params: Optional[Dict[str, Any]] = None,
    duration: Optional[float] = None,
    filename: Optional[str] = None,
    key_signature: Optional[str] = None,
    bpm: Optional[float] = None,
    time_signature: Optional[int] = None,
) -> bool:
    now = _now()
    conn = _db()
    try:
        conn.execute(
            """
            INSERT INTO analyses (cache_key, kind, audio_id, model, params, payload,
                                  duration, filename, key_signature, bpm, time_signature,
                                  created_at, last_used_at, hits)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(cache_key) DO UPDATE SET
                payload = excluded.payload,
                model = excluded.model,
                params = excluded.params,
                duration = excluded.duration,
                filename = excluded.filename,
                key_signature = COALESCE(excluded.key_signature, analyses.key_signature),
                bpm = COALESCE(excluded.bpm, analyses.bpm),
                time_signature = COALESCE(excluded.time_signature, analyses.time_signature),
                last_used_at = excluded.last_used_at
            """,
            (
                cache_key,
                kind,
                audio_id,
                model,
                json.dumps(params or {}, ensure_ascii=False, sort_keys=True),
                json.dumps(payload, ensure_ascii=False),
                duration,
                filename,
                key_signature,
                bpm,
                time_signature,
                now,
                now,
            ),
        )
        conn.commit()
        return True
    except sqlite3.DatabaseError as exc:
        log_error(f"analysis_put failed: {exc}")
        return False
    finally:
        conn.close()


def analysis_set_key(audio_id: str, key_signature: str) -> int:
    """Fill in the key signature on every analysis row of an audio (the detect-key result arrives after the chord analysis).

    Returns the number of updated rows; 0 on failure.
    """
    if not audio_id or not key_signature:
        return 0
    conn = _db()
    try:
        cursor = conn.execute(
            "UPDATE analyses SET key_signature = ? WHERE audio_id = ?",
            (key_signature, audio_id),
        )
        conn.commit()
        return cursor.rowcount or 0
    except sqlite3.DatabaseError as exc:
        log_error(f"analysis_set_key failed: {exc}")
        return 0
    finally:
        conn.close()


def recent_analyses(
    limit: int = 20,
    key_signature: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Newest cached analyses first. Used by the "recent analyses" list.

    The ``key_signature`` filter happens in SQL; one audio may have several rows (chords /
    harmony / beats), and deduplication is done by cache_service.recent().
    """
    conn = _db()
    try:
        sql = """
            SELECT cache_key, kind, audio_id, model, duration, filename,
                   key_signature, bpm, time_signature,
                   created_at, last_used_at, hits
            FROM analyses
        """
        params: List[Any] = []
        if key_signature:
            sql += " WHERE key_signature = ?"
            params.append(key_signature)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(max(1, min(limit, 500)))

        rows = conn.execute(sql, tuple(params)).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.DatabaseError as exc:
        log_error(f"recent_analyses failed: {exc}")
        return []
    finally:
        conn.close()


def analysis_count() -> int:
    conn = _db()
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM analyses").fetchone()
        return int(row["n"]) if row else 0
    except sqlite3.DatabaseError:
        return 0
    finally:
        conn.close()


def purge_expired_analyses(ttl_days: Optional[float] = None) -> int:
    """Drop analyses untouched for longer than the TTL (0 disables expiry)."""
    ttl = CACHE_TTL_DAYS if ttl_days is None else ttl_days
    if not ttl or ttl <= 0:
        return 0
    cutoff = _now() - ttl * 86400
    conn = _db()
    try:
        cursor = conn.execute("DELETE FROM analyses WHERE last_used_at < ?", (cutoff,))
        conn.commit()
        removed = cursor.rowcount or 0
        if removed:
            log_debug(f"Purged {removed} expired analyses (ttl {ttl}d)")
        return removed
    except sqlite3.DatabaseError as exc:
        log_error(f"purge_expired_analyses failed: {exc}")
        return 0
    finally:
        conn.close()


def analysis_forget_audio(audio_id: str) -> int:
    """Delete every analysis row of one audio (chords / beats / harmony).

    Called when an audio is deleted on its own: analysis rows are keyed by the audio content hash, so leaving them lets them still hit, but the user
    has already removed the track in the UI, so keeping it in the "recent" list is misleading.
    """
    if not audio_id:
        return 0
    conn = _db()
    try:
        cursor = conn.execute("DELETE FROM analyses WHERE audio_id = ?", (audio_id,))
        conn.commit()
        return cursor.rowcount or 0
    except sqlite3.DatabaseError as exc:
        log_error(f"analysis_forget_audio failed: {exc}")
        return 0
    finally:
        conn.close()


def analyses_clear() -> int:
    """Clear the analyses table; returns the number of deleted rows."""
    conn = _db()
    try:
        cursor = conn.execute("DELETE FROM analyses")
        conn.commit()
        return cursor.rowcount or 0
    except sqlite3.DatabaseError as exc:
        log_error(f"analyses_clear failed: {exc}")
        return 0
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Audio file registry
# --------------------------------------------------------------------------- #
def audio_upsert(
    audio_id: str,
    path: str,
    size: int,
    ext: str,
    filename: Optional[str] = None,
    sha256: Optional[str] = None,
    duration: Optional[float] = None,
) -> bool:
    now = _now()
    conn = _db()
    try:
        conn.execute(
            """
            INSERT INTO audio_files (audio_id, filename, ext, size, path, sha256,
                                     duration, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(audio_id) DO UPDATE SET
                path = excluded.path,
                size = excluded.size,
                last_used_at = excluded.last_used_at,
                duration = COALESCE(excluded.duration, audio_files.duration),
                filename = COALESCE(excluded.filename, audio_files.filename)
            """,
            (audio_id, filename, ext, size, path, sha256 or audio_id, duration, now, now),
        )
        conn.commit()
        return True
    except sqlite3.DatabaseError as exc:
        log_error(f"audio_upsert failed: {exc}")
        return False
    finally:
        conn.close()


def audio_touch(audio_id: str) -> None:
    conn = _db()
    try:
        conn.execute(
            "UPDATE audio_files SET last_used_at = ? WHERE audio_id = ?", (_now(), audio_id)
        )
        conn.commit()
    except sqlite3.DatabaseError:
        pass
    finally:
        conn.close()


def audio_set_duration(audio_id: str, duration: Optional[float]) -> None:
    if duration is None:
        return
    conn = _db()
    try:
        conn.execute(
            "UPDATE audio_files SET duration = ? WHERE audio_id = ?", (float(duration), audio_id)
        )
        conn.commit()
    except sqlite3.DatabaseError:
        pass
    finally:
        conn.close()


def audio_get(audio_id: str) -> Optional[Dict[str, Any]]:
    conn = _db()
    try:
        row = conn.execute(
            "SELECT * FROM audio_files WHERE audio_id = ?", (audio_id,)
        ).fetchone()
        return dict(row) if row else None
    except sqlite3.DatabaseError:
        return None
    finally:
        conn.close()


def audio_lru(limit: int = 1000) -> List[Dict[str, Any]]:
    """Least recently used first."""
    conn = _db()
    try:
        rows = conn.execute(
            """
            SELECT audio_id, path, size, filename, last_used_at
            FROM audio_files ORDER BY last_used_at ASC LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.DatabaseError:
        return []
    finally:
        conn.close()


def audio_forget(audio_ids: List[str]) -> int:
    if not audio_ids:
        return 0
    conn = _db()
    try:
        deleted = 0
        for audio_id in audio_ids:
            cursor = conn.execute("DELETE FROM audio_files WHERE audio_id = ?", (audio_id,))
            deleted += cursor.rowcount or 0
        conn.commit()
        return deleted
    except sqlite3.DatabaseError:
        return 0
    finally:
        conn.close()


def audio_clear() -> int:
    """Clear the audio_files registry; returns the number of deleted rows (the caller deletes the bytes)."""
    conn = _db()
    try:
        cursor = conn.execute("DELETE FROM audio_files")
        conn.commit()
        return cursor.rowcount or 0
    except sqlite3.DatabaseError as exc:
        log_error(f"audio_clear failed: {exc}")
        return 0
    finally:
        conn.close()


def audio_totals() -> Dict[str, int]:
    conn = _db()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM audio_files"
        ).fetchone()
        return {"files": int(row["n"]), "bytes": int(row["bytes"])} if row else {"files": 0, "bytes": 0}
    except sqlite3.DatabaseError:
        return {"files": 0, "bytes": 0}
    finally:
        conn.close()