"""Local cache layer (Phase 3).

Replaces the Firestore/REST admin access and Firebase Storage dependency of the
upstream project. Everything in this package is local-disk only: no network
calls, no credentials, no cloud SDK. Safe to run fully offline.

Layout::

    services/cache/sqlite_store.py   SQLite schema + key/value + analysis cache
    services/cache/audio_store.py    content-addressed audio directory + LRU
    services/cache/cache_service.py  high-level API used by the blueprints
"""