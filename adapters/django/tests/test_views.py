import json
import os

import pytest
from django.test import RequestFactory

from vds_form.submission import TrustedSubmissionHandler, OperationRegistry, SimpleRbacEvaluator
from vds_form_renderer.views import create_form_view

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
    with open(os.path.join(FIX, name + ".ir.json"), encoding="utf-8") as fh:
        return json.load(fh)


class User:
    is_authenticated = True
    pk = "u1"
    tenant_id = "t1"

    def __init__(self, perms):
        self._perms = perms

    def get_all_permissions(self):
        return set(self._perms)


def setup(perms=("customer:create",)):
    records = []
    ops = OperationRegistry()
    ops.register("test:customer.create", lambda payload, ctx: records.append(payload) or {"id": "C1"})
    ir = load("customer-registration")
    handler = TrustedSubmissionHandler(forms={"customer-registration": ir}, operations=ops, rbac=SimpleRbacEvaluator())
    view = create_form_view(handler, {"customer-registration": ir}, auth_resolver=lambda req: {
        "userId": "u1", "tenantId": "t1", "roles": [], "permissions": list(req.perms),
    }, base_path="/forms")
    return view, records


VALID = {"customer": {"name": "Ada Lovelace", "email": "ada@example.com", "type": "individual", "consent": True}}


def test_get_renders_page():
    view, _ = setup()
    req = RequestFactory().get("/forms/customer-registration")
    req.perms = ["customer:create"]
    res = view(req, form_id="customer-registration")
    assert res.status_code == 200
    assert b"<!doctype html>" in res.content
    assert b'data-vds-form="customer-registration"' in res.content


def test_post_json_success():
    view, records = setup()
    req = RequestFactory().post("/forms/customer-registration?format=json", data=json.dumps({"values": VALID, "idempotencyKey": "k1"}), content_type="application/json")
    req.perms = ["customer:create"]
    res = view(req, form_id="customer-registration")
    assert res.status_code == 200
    assert json.loads(res.content)["status"] == "succeeded"
    assert len(records) == 1


def test_post_form_validation_errors():
    view, records = setup()
    req = RequestFactory().post("/forms/customer-registration", data={"customer.name": "Ada"})
    req.perms = ["customer:create"]
    res = view(req, form_id="customer-registration")
    assert res.status_code == 422
    assert b"data-error-for" in res.content
    assert len(records) == 0


def test_post_permission_denied():
    view, records = setup()
    req = RequestFactory().post("/forms/customer-registration?format=json", data=json.dumps({"values": VALID, "idempotencyKey": "k2"}), content_type="application/json")
    req.perms = []
    res = view(req, form_id="customer-registration")
    assert res.status_code == 403
    assert len(records) == 0


def test_auth_in_body_rejected():
    view, records = setup()
    req = RequestFactory().post("/forms/customer-registration?format=json", data=json.dumps({"values": VALID, "auth": {"permissions": ["*"]}}), content_type="application/json")
    req.perms = []
    res = view(req, form_id="customer-registration")
    assert res.status_code == 400
    assert json.loads(res.content)["code"] == "AUTH_IN_BODY_FORBIDDEN"
    assert len(records) == 0
