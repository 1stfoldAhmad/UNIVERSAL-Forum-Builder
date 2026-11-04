"""Idempotency lease/expiry recovery for the trusted Django adapter."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vds_form.idempotency import InMemoryIdempotencyStore, SqliteIdempotencyStore
from vds_form.submission import TrustedSubmissionHandler, OperationRegistry

RESULT = {"status": "succeeded", "operationRef": "test:contact.create", "data": {"id": "r1"}, "idempotencyKey": "k", "durationMs": 1}


def test_in_memory_lease_expiry_and_reconciliation():
    store = InMemoryIdempotencyStore()
    assert store.claim("k", "fp", {"now": 1000, "leaseMs": 1000}) == {"kind": "claimed"}
    assert store.claim("k", "fp", {"now": 1500, "leaseMs": 1000}) == {"kind": "in-progress"}
    assert store.claim("k", "other", {"now": 1500}) == {"kind": "conflict"}
    assert store.claim("k", "fp", {"now": 2001, "leaseMs": 1000}) == {"kind": "expired", "claimedAt": 1000, "leaseExpiresAt": 2000}
    store.complete("k", RESULT)
    assert store.claim("k", "fp", {"now": 3000}) == {"kind": "replay", "result": RESULT}


def test_sqlite_restart_expiry_and_replay():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "idem.sqlite")
        a = SqliteIdempotencyStore(path)
        assert a.claim("k", "fp", {"now": 1000, "leaseMs": 1000}) == {"kind": "claimed"}
        a.close()
        b = SqliteIdempotencyStore(path)
        assert b.claim("k", "fp", {"now": 1500, "leaseMs": 1000}) == {"kind": "in-progress"}
        assert b.claim("k", "fp", {"now": 2001, "leaseMs": 1000}) == {"kind": "expired", "claimedAt": 1000, "leaseExpiresAt": 2000}
        assert b.claim("k", "other", {"now": 2001}) == {"kind": "conflict"}
        b.complete("k", RESULT)
        b.close()
        c = SqliteIdempotencyStore(path)
        assert c.claim("k", "fp", {"now": 9999}) == {"kind": "replay", "result": RESULT}
        c.close()


class ExpiredStore:
    def claim(self, key, fingerprint, opts=None):
        return {"kind": "expired", "claimedAt": 1, "leaseExpiresAt": 2}

    def complete(self, key, result):
        pass

    def release(self, key):
        pass


def test_handler_expired_claim_requires_recovery():
    here = os.path.dirname(__file__)
    import json
    with open(os.path.join(here, "fixtures", "ir", "contact.ir.json"), encoding="utf-8") as fh:
        ir = json.load(fh)
    calls = []
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: calls.append(1) or {"id": "x"})
    handler = TrustedSubmissionHandler({"contact": ir}, ops, idempotency_store=ExpiredStore())
    r = handler.handle({"formId": "contact", "values": {"name": "Ada Lovelace", "email": "ada@example.com", "message": "Hello from the recovery test."}, "idempotencyKey": "k", "correlationId": "c"}, None)
    assert r["status"] == "business-rejected" and r["code"] == "IDEMPOTENCY_RECOVERY_REQUIRED"
    assert calls == []
