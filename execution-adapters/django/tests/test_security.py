"""Adversarial security tests for the trusted Django/Python adapter (audit P0/P1).
Mirrors execution-adapters/node/tests/security.test.ts."""
import json
import os
import sys
import tempfile
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vds_form.submission import TrustedSubmissionHandler, OperationRegistry, SimpleRbacEvaluator
from vds_form.idempotency import (
    InMemoryIdempotencyStore, SqliteIdempotencyStore,
    canonical_json, payload_fingerprint, scoped_idempotency_key,
)

HERE = os.path.dirname(__file__)
VALID = {"name": "Ada Lovelace", "email": "ada@example.com", "message": "Hello from the Django adapter."}


def load_ir():
    with open(os.path.join(HERE, "fixtures", "ir", "contact.ir.json"), encoding="utf-8") as fh:
        return json.load(fh)


def gated_ir():
    ir = load_ir()
    ir.setdefault("security", {})["submitPermissions"] = ["contact:create"]
    return ir


def req(over=None):
    base = {"formId": "contact", "values": dict(VALID), "idempotencyKey": "k", "correlationId": "c"}
    if over:
        base.update(over)
    return base


def auth(user_id, perms, tenant="t1"):
    return {"userId": user_id, "tenantId": tenant, "roles": [], "permissions": perms}


def setup(store=None, allowed=None, ir=None):
    ops = OperationRegistry()
    calls = []
    ops.register("test:contact.create", lambda p, c: calls.append("contact.create") or {"id": f"rec-{len(calls)}"})
    ops.register("test:admin.wipe", lambda p, c: calls.append("admin.wipe") or {"wiped": True})
    handler = TrustedSubmissionHandler({"contact": ir or load_ir()}, ops, rbac=SimpleRbacEvaluator(),
                                       idempotency_store=store, allowed_operations=allowed)
    return handler, calls


# ---- Operation binding (finding 2) ----

def test_operation_override_rejected():
    handler, calls = setup(ir=gated_ir())
    r = handler.handle(req({"operationRef": "test:admin.wipe"}), auth("u1", ["contact:create", "admin:wipe"]))
    assert r["status"] == "permission-denied" and r["code"] == "OPERATION_OVERRIDE_FORBIDDEN"
    assert calls == []


def test_operation_allowlist_enforced():
    handler, calls = setup(allowed=["test:other"], ir=gated_ir())
    r = handler.handle(req(), auth("u1", ["contact:create"]))
    assert r["status"] == "permission-denied" and r["code"] == "OPERATION_NOT_ALLOWED"
    assert calls == []


# ---- Idempotency isolation (finding 3) ----

def test_no_cross_user_replay():
    handler, calls = setup(ir=gated_ir())
    r1 = handler.handle(req(), auth("alice", ["contact:create"]))
    r2 = handler.handle(req(), auth("bob", ["contact:create"]))
    assert r1["status"] == "succeeded" and r2["status"] == "succeeded"
    assert calls == ["contact.create", "contact.create"]
    assert r1["data"]["id"] != r2["data"]["id"]


def test_tenant_isolation():
    handler, calls = setup(ir=gated_ir())
    handler.handle(req(), auth("u1", ["contact:create"], tenant="a"))
    handler.handle(req(), auth("u1", ["contact:create"], tenant="b"))
    assert len(calls) == 2


def test_same_principal_replays():
    handler, calls = setup(ir=gated_ir())
    r1 = handler.handle(req(), auth("alice", ["contact:create"]))
    r2 = handler.handle(req(), auth("alice", ["contact:create"]))
    assert r1 == r2
    assert calls == ["contact.create"]


def test_payload_swap_conflict():
    handler, calls = setup(ir=gated_ir())
    r1 = handler.handle(req(), auth("alice", ["contact:create"]))
    assert r1["status"] == "succeeded"
    swapped = dict(VALID, email="different@example.com")
    r2 = handler.handle(req({"values": swapped}), auth("alice", ["contact:create"]))
    assert r2["status"] == "business-rejected" and r2["code"] == "IDEMPOTENCY_KEY_CONFLICT"
    assert calls == ["contact.create"]


def test_authorization_before_replay():
    handler, calls = setup(ir=gated_ir())
    ok = handler.handle(req(), auth("alice", ["contact:create"]))
    assert ok["status"] == "succeeded"
    denied = handler.handle(req(), auth("alice", []))  # permission revoked, same key
    assert denied["status"] == "permission-denied" and denied["code"] == "PERMISSION_DENIED"
    assert calls == ["contact.create"]


def test_concurrent_double_execution_prevented():
    ops = OperationRegistry()
    gate = threading.Event()
    executions = []

    def op(p, c):
        executions.append(1)
        gate.wait(timeout=5)
        return {"id": "rec-1"}

    ops.register("test:contact.create", op)
    handler = TrustedSubmissionHandler({"contact": gated_ir()}, ops, rbac=SimpleRbacEvaluator())
    a = auth("alice", ["contact:create"])
    results = {}

    def first():
        results["r1"] = handler.handle(req(), a)

    t = threading.Thread(target=first)
    t.start()
    # Wait until the first request has claimed and entered the operation.
    import time
    deadline = time.time() + 5
    while not executions and time.time() < deadline:
        time.sleep(0.01)
    r2 = handler.handle(req(), a)  # same scoped key, still in progress
    assert r2["status"] == "business-rejected" and r2["code"] == "IDEMPOTENCY_IN_PROGRESS"
    gate.set()
    t.join(timeout=5)
    assert results["r1"]["status"] == "succeeded"
    assert len(executions) == 1


def test_durable_sqlite_replay_across_restart():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "idem.sqlite")
        store1 = SqliteIdempotencyStore(path)
        h1, c1 = setup(store=store1, ir=gated_ir())
        r1 = h1.handle(req(), auth("alice", ["contact:create"]))
        assert r1["status"] == "succeeded" and c1 == ["contact.create"]
        store1.close()
        # Simulated restart: new store + handler on the same file.
        store2 = SqliteIdempotencyStore(path)
        h2, c2 = setup(store=store2, ir=gated_ir())
        r2 = h2.handle(req(), auth("alice", ["contact:create"]))
        assert r2 == r1
        assert c2 == []
        store2.close()


# ---- Client auth never trusted (finding 1) ----

def test_forged_auth_in_request_ignored():
    handler, calls = setup(ir=gated_ir())
    forged = req()
    forged["auth"] = {"userId": "attacker", "permissions": ["*"]}
    # The handler only reads the trusted second argument; request["auth"] is inert.
    r = handler.handle(forged, auth("real-user", []))
    assert r["status"] == "permission-denied" and r["code"] == "PERMISSION_DENIED"
    assert calls == []


def test_forged_identity_fields_never_honored():
    # Forge EVERY identity field; the operation must see only the server principal.
    seen = {}
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: seen.update(c["auth"] or {}) or {"id": "rec-1"})
    handler = TrustedSubmissionHandler({"contact": gated_ir()}, ops, rbac=SimpleRbacEvaluator())
    forged = req()
    forged["auth"] = {"userId": "attacker", "tenantId": "evil-tenant", "roles": ["admin"], "permissions": ["*"]}
    server_principal = {"userId": "real-user", "tenantId": "real-tenant", "roles": ["member"], "permissions": ["contact:create"]}
    r = handler.handle(forged, server_principal)
    assert r["status"] == "succeeded"
    assert seen == server_principal
    assert seen["userId"] == "real-user" and seen["tenantId"] == "real-tenant"
    assert seen["roles"] == ["member"] and seen["permissions"] == ["contact:create"]


# ---- Canonical determinism (cross-language parity) ----

def test_canonical_json_key_order_independent():
    assert canonical_json({"b": 1, "a": {"d": 2, "c": 3}}) == canonical_json({"a": {"c": 3, "d": 2}, "b": 1})


def test_fingerprint_stable_and_sensitive():
    assert payload_fingerprint({"a": 1, "b": 2}) == payload_fingerprint({"b": 2, "a": 1})
    assert payload_fingerprint({"a": 1, "b": 2}) != payload_fingerprint({"a": 1, "b": 3})


def test_scoped_key_dimensions():
    base = dict(tenant_id="t", user_id="u", form_id="f", operation_ref="op", idempotency_key="k")
    k = scoped_idempotency_key(**base)
    assert scoped_idempotency_key(**{**base, "user_id": "u2"}) != k
    assert scoped_idempotency_key(**{**base, "tenant_id": "t2"}) != k
    assert scoped_idempotency_key(**{**base, "form_id": "f2"}) != k
    assert scoped_idempotency_key(**{**base, "operation_ref": "op2"}) != k
    assert scoped_idempotency_key(**base) == k
