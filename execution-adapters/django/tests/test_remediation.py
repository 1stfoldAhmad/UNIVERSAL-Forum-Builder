"""Audit remediation regressions for the trusted Django handler (Stages 3–4)."""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vds_form.submission import TrustedSubmissionHandler, OperationRegistry, SimpleRbacEvaluator

HERE = os.path.dirname(__file__)
VALID = {"name": "Ada Lovelace", "email": "ada@example.com", "message": "Hello from the Django adapter."}


def load_ir():
    with open(os.path.join(HERE, "fixtures", "ir", "contact.ir.json"), encoding="utf-8") as fh:
        return json.load(fh)


def handler(ir, op):
    ops = OperationRegistry()
    calls = []
    ops.register("test:contact.create", lambda p, c: calls.append(p) or op(p, c))
    return TrustedSubmissionHandler({"contact": ir}, ops, rbac=SimpleRbacEvaluator()), calls


def req(values, key="k"):
    return {"formId": "contact", "values": values, "idempotencyKey": key, "correlationId": "c"}


def test_unknown_root_property_rejected_before_operation():
    ir = load_ir()
    h, calls = handler(ir, lambda p, c: p)
    r = h.handle(req({**VALID, "isAdmin": True}), {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": []})
    assert r["status"] == "server-validation-failed"
    assert any(i["code"] == "UNKNOWN_PROPERTY" for i in r["issues"])
    assert calls == []


def test_prototype_pollution_rejected():
    ir = load_ir()
    h, calls = handler(ir, lambda p, c: p)
    values = json.loads('{"name":"Ada","email":"ada@example.com","message":"Hello from the Django adapter.","__proto__":{"polluted":true}}')
    r = h.handle(req(values), {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": []})
    assert r["status"] == "server-validation-failed"
    assert any(i["code"] == "UNSAFE_PROPERTY" for i in r["issues"])
    assert calls == []


def test_read_protected_result_is_filtered():
    ir = load_ir()
    ir.setdefault("security", {})["fieldAccess"] = {"email": {"read": ["email:read"]}}
    h, calls = handler(ir, lambda p, c: {**p, "id": "rec-1"})
    r = h.handle(req(VALID), {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": []})
    assert r["status"] == "succeeded"
    assert "email" not in r["data"]
    assert r["data"]["name"] == "Ada Lovelace"
    assert len(calls) == 1


def test_typed_operation_inputs_preserved_and_unknown_members_rejected():
    ir = load_ir()
    ir["submission"]["operationInputs"] = {"meta": {"valueType": "object", "properties": {"source": {"valueType": "string"}}}}
    h, calls = handler(ir, lambda p, c: p)
    auth = {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": []}
    ok = h.handle(req({**VALID, "meta": {"source": "web"}}, "ok"), auth)
    assert ok["status"] == "succeeded"
    assert calls[0]["meta"] == {"source": "web"}
    bad = h.handle(req({**VALID, "meta": {"source": "web", "extra": True}}, "bad"), auth)
    assert bad["status"] == "server-validation-failed"
    assert len(calls) == 1


def test_idempotent_replay_refilters_read_permissions():
    ir = load_ir()
    ir.setdefault("security", {})["fieldAccess"] = {"email": {"read": ["email:read"]}}
    calls = []
    h, _ = handler(ir, lambda p, c: calls.append(p) or {**p, "id": "rec-1"})
    request = req(VALID, "same-key")
    first = h.handle(request, {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": ["email:read"]})
    second = h.handle(request, {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": []})
    assert first["status"] == second["status"] == "succeeded"
    assert "email" in first["data"]
    assert "email" not in second["data"]
    assert len(calls) == 1


def test_field_write_protection_on_repeater_null_value():
    ir = load_ir()
    ir["fields"].extend([
        {"id": "items", "key": "items", "type": "repeater", "valueType": "object[]", "children": ["secret"]},
        {"id": "secret", "key": "items[].secret", "type": "text", "valueType": "string", "repeaterId": "items"},
    ])
    ir.setdefault("security", {})["fieldAccess"] = {"secret": {"write": ["secret:write"]}}
    h, calls = handler(ir, lambda p, c: p)
    r = h.handle(req({**VALID, "items": [{"secret": None}]}), {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": []})
    assert r["status"] == "permission-denied"
    assert r["code"] == "FIELD_WRITE_DENIED"
    assert calls == []
