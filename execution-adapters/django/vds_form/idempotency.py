"""Atomic idempotency storage for the trusted Django/Python execution adapter.

Mirrors execution-adapters/node/src/idempotency.ts byte-for-byte so the canonical
payload fingerprint and scoped key are identical across languages:

- Keys are scoped by tenant + user + form + operation (no cross-principal replay).
- Every claim carries a canonical SHA-256 payload fingerprint (no payload-swap).
- ``claim`` is atomic (a lock for the in-memory store; a UNIQUE primary key for
  SQLite), so concurrent requests with the same scoped key cannot all execute.
- ``IdempotencyStore`` is a protocol: hosts plug in a durable database-backed
  store. ``SqliteIdempotencyStore`` is a durable reference; the in-memory store
  is single-process and explicitly NOT durable across restarts.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from typing import Any, Dict, Optional, Protocol

DEFAULT_IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000


def canonical_json(value: Any) -> str:
    """Canonical JSON: recursively sorted object keys, no whitespace, UTF-8.

    Matches the TypeScript canonicalJson so fingerprints agree cross-language.
    """
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    keys = sorted(value.keys())
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k]) for k in keys) + "}"


def payload_fingerprint(values: Any) -> str:
    return hashlib.sha256(canonical_json(values).encode("utf-8")).hexdigest()


def scoped_idempotency_key(*, tenant_id: Optional[str], user_id: Optional[str],
                           form_id: str, operation_ref: str, idempotency_key: str) -> str:
    parts = [tenant_id or "", user_id or "", form_id, operation_ref, idempotency_key]
    return hashlib.sha256(canonical_json(parts).encode("utf-8")).hexdigest()


class IdempotencyStore(Protocol):
    def claim(self, key: str, fingerprint: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]: ...
    def complete(self, key: str, result: Dict[str, Any]) -> None: ...
    def release(self, key: str) -> None: ...


class InMemoryIdempotencyStore:
    """Single-process atomic store (lock-guarded). NOT durable across restarts."""

    def __init__(self) -> None:
        self._records: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def claim(self, key: str, fingerprint: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        opts = opts or {}
        now = opts.get("now", int(time.time() * 1000))
        lease_ms = opts.get("leaseMs", DEFAULT_IDEMPOTENCY_LEASE_MS)
        with self._lock:
            rec = self._records.get(key)
            if rec is None:
                self._records[key] = {"fingerprint": fingerprint, "status": "in-progress", "claimedAt": now, "leaseExpiresAt": now + lease_ms if lease_ms > 0 else 0}
                return {"kind": "claimed"}
            if rec["fingerprint"] != fingerprint:
                return {"kind": "conflict"}
            if rec["status"] == "complete" and rec.get("result") is not None:
                return {"kind": "replay", "result": rec["result"]}
            if rec.get("leaseExpiresAt", 0) > 0 and now > rec["leaseExpiresAt"]:
                return {"kind": "expired", "claimedAt": rec["claimedAt"], "leaseExpiresAt": rec["leaseExpiresAt"]}
            return {"kind": "in-progress"}

    def complete(self, key: str, result: Dict[str, Any]) -> None:
        with self._lock:
            rec = self._records.get(key)
            if rec is not None:
                rec["status"] = "complete"
                rec["result"] = result

    def release(self, key: str) -> None:
        with self._lock:
            rec = self._records.get(key)
            if rec is not None and rec["status"] == "in-progress":
                del self._records[key]


class SqliteIdempotencyStore:
    """Durable reference store (stdlib sqlite3). The UNIQUE primary key makes
    claim atomic across processes. Production hosts may substitute Postgres/
    MySQL via the IdempotencyStore protocol."""

    def __init__(self, path: str) -> None:
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS vds_form_idempotency (
                key TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('in-progress','complete')),
                result_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                claimed_at INTEGER NOT NULL DEFAULT 0,
                lease_expires_at INTEGER NOT NULL DEFAULT 0
            )"""
        )
        for col in ("claimed_at INTEGER NOT NULL DEFAULT 0", "lease_expires_at INTEGER NOT NULL DEFAULT 0"):
            try:
                self._conn.execute(f"ALTER TABLE vds_form_idempotency ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass
        self._conn.commit()

    def claim(self, key: str, fingerprint: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        opts = opts or {}
        now = opts.get("now", int(time.time() * 1000))
        lease_ms = opts.get("leaseMs", DEFAULT_IDEMPOTENCY_LEASE_MS)
        lease_expires_at = now + lease_ms if lease_ms > 0 else 0
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO vds_form_idempotency (key, fingerprint, status, claimed_at, lease_expires_at) VALUES (?, ?, 'in-progress', ?, ?)",
                    (key, fingerprint, now, lease_expires_at),
                )
                self._conn.commit()
                return {"kind": "claimed"}
            except sqlite3.IntegrityError:
                row = self._conn.execute(
                    "SELECT fingerprint, status, result_json, claimed_at, lease_expires_at FROM vds_form_idempotency WHERE key = ?", (key,)
                ).fetchone()
                if row is None:
                    return {"kind": "in-progress"}
                fp, status, result_json, claimed_at, db_lease = row
                if fp != fingerprint:
                    return {"kind": "conflict"}
                if status == "complete" and result_json is not None:
                    return {"kind": "replay", "result": json.loads(result_json)}
                if db_lease > 0 and now > db_lease:
                    return {"kind": "expired", "claimedAt": claimed_at, "leaseExpiresAt": db_lease}
                return {"kind": "in-progress"}

    def complete(self, key: str, result: Dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE vds_form_idempotency SET status = 'complete', result_json = ? WHERE key = ?",
                (json.dumps(result), key),
            )
            self._conn.commit()

    def release(self, key: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM vds_form_idempotency WHERE key = ? AND status = 'in-progress'", (key,))
            self._conn.commit()

    def close(self) -> None:
        self._conn.close()
