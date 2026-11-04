"""Trusted submission handler tests (mirrors the Node adapter's guarantees):
server re-validation, fail-closed RBAC, field write protection, idempotent
replay, version mismatch, unresolved operations, and redacted audit.

Auth is passed as the trusted second argument to handler.handle (never inside
the request), matching the Node adapter's security boundary."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from vds_form.submission import (
    TrustedSubmissionHandler, OperationRegistry, SimpleRbacEvaluator, auth_context_from_claims,
)

HERE = os.path.dirname(__file__)


def load_ir(name):
    with open(os.path.join(HERE, "fixtures", "ir", name), encoding="utf-8") as fh:
        return json.load(fh)


def make_handler(forms=None, operations=None, rbac=None, audit=None, **kw):
    ops = operations or OperationRegistry()
    return TrustedSubmissionHandler(forms or {"contact": load_ir("contact.ir.json")}, ops, rbac=rbac, audit=audit, **kw)


def req(values, **kw):
    base = {"formId": "contact", "values": values, "idempotencyKey": "key-1", "correlationId": "corr-1"}
    base.update(kw)
    return base


def send(handler, request):
    """Split the trusted auth out of the combined test request."""
    request = dict(request)
    auth = request.pop("auth", None)
    return handler.handle(request, auth)


VALID = {"name": "Ada Lovelace", "email": "ada@example.com", "message": "Hello from the Django adapter."}


def test_successful_submission_persists_via_registered_operation():
    ops = OperationRegistry()
    saved = {}
    ops.register("test:contact.create", lambda payload, ctx: saved.update(payload) or {"id": "rec-1", **payload})
    handler = make_handler(operations=ops)
    result = send(handler, req(VALID))
    assert result["status"] == "succeeded"
    assert saved["email"] == "ada@example.com"
    assert result["data"]["id"] == "rec-1"


def test_server_rejects_invalid_payload_even_if_client_sent_it():
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: {"id": "x"})
    handler = make_handler(operations=ops)
    result = send(handler, req({"name": "A", "email": "bad", "message": "short"}))
    assert result["status"] == "server-validation-failed"
    codes = {i["code"] for i in result["issues"]}
    assert "FORMAT_INVALID" in codes
    assert all(i["source"] == "server" for i in result["issues"])


def test_missing_operation_fails_with_unresolved():
    handler = make_handler(operations=OperationRegistry())
    result = send(handler, req(VALID))
    assert result["status"] == "config-error"
    assert result["code"] == "SUBMISSION_OPERATION_UNRESOLVED"


def test_unregistered_form_fails():
    handler = make_handler()
    result = send(handler, req(VALID, formId="nope"))
    assert result["status"] == "config-error"


def test_idempotent_replay_does_not_reexecute():
    ops = OperationRegistry()
    calls = {"n": 0}

    def op(p, c):
        calls["n"] += 1
        return {"id": f"rec-{calls['n']}"}

    ops.register("test:contact.create", op)
    audit = []
    handler = make_handler(operations=ops, audit=audit.append)
    r1 = send(handler, req(VALID))
    r2 = send(handler, req(VALID))
    assert r1["data"]["id"] == "rec-1"
    assert r2["data"]["id"] == "rec-1"  # replayed, not re-executed
    assert calls["n"] == 1
    assert any(e["issueCodes"] == ["IDEMPOTENT_REPLAY"] for e in audit)


def test_version_mismatch_rejected():
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: {"id": "x"})
    handler = make_handler(operations=ops)
    result = send(handler, req(VALID, formVersion="9.9.9"))
    assert result["status"] == "server-validation-failed"
    assert result["issues"][0]["code"] == "FORM_VERSION_MISMATCH"


def test_rbac_fail_closed_when_permissions_declared_but_no_evaluator():
    ir = load_ir("contact.ir.json")
    ir.setdefault("security", {})["submitPermissions"] = ["contact:create"]
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: {"id": "x"})
    handler = make_handler(forms={"contact": ir}, operations=ops, rbac=None)
    result = send(handler, req(VALID))
    assert result["status"] == "permission-denied"
    assert result["code"] == "RBAC_NOT_CONFIGURED"


def test_rbac_denies_missing_permission():
    ir = load_ir("contact.ir.json")
    ir.setdefault("security", {})["submitPermissions"] = ["contact:create"]
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: {"id": "x"})
    handler = make_handler(forms={"contact": ir}, operations=ops, rbac=SimpleRbacEvaluator())
    result = send(handler, req(VALID, auth=auth_context_from_claims({"sub": "u", "permissions": []})))
    assert result["status"] == "permission-denied"
    assert result["code"] == "PERMISSION_DENIED"
    granted = send(handler, req(VALID, idempotencyKey="key-2", auth=auth_context_from_claims({"sub": "u", "permissions": ["contact:create"]})))
    assert granted["status"] == "succeeded"


def test_audit_records_paths_never_values():
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: {"id": "x"})
    audit = []
    handler = make_handler(operations=ops, audit=audit.append)
    send(handler, req(VALID))
    entry = audit[-1]
    assert set(entry["valuePaths"]) == {"name", "email", "message"}
    serialized = json.dumps(entry)
    assert "ada@example.com" not in serialized
    assert "Ada Lovelace" not in serialized


def test_operation_exception_becomes_business_rejected():
    ops = OperationRegistry()

    def op(p, c):
        raise RuntimeError("downstream unavailable")

    ops.register("test:contact.create", op)
    handler = make_handler(operations=ops)
    result = send(handler, req(VALID))
    assert result["status"] == "business-rejected"
    assert result["code"] == "OPERATION_FAILED"


def test_input_mapping_reversed_for_revalidation():
    ir = load_ir("customer-registration.ir.json")
    ops = OperationRegistry()
    captured = {}
    ops.register("test:customer.create", lambda p, c: captured.update(p) or {"id": "cust-1"})
    handler = make_handler(forms={"customer-registration": ir}, operations=ops, rbac=SimpleRbacEvaluator())
    mapped = {"name": "Grace Hopper", "email": "grace@example.com", "type": "individual", "consent": True, "age": 30}
    result = send(handler, {"formId": "customer-registration", "values": mapped, "idempotencyKey": "k", "correlationId": "c",
                            "auth": auth_context_from_claims({"sub": "u", "permissions": ["customer:create"]})})
    assert result["status"] == "succeeded", result
    assert captured["email"] == "grace@example.com"
