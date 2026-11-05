"""Django HTTP view integration tests. Skips if Django is not installed (the
framework-free core tests never require it).

These exercise the P0 security boundary: auth is derived from the server-side
principal / a host auth_resolver, NEVER from the request body."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

django = pytest.importorskip("django")
from django.conf import settings

if not settings.configured:
    settings.configure(DEBUG=True, ALLOWED_HOSTS=["*"], SECRET_KEY="test", ROOT_URLCONF=__name__)
    django.setup()

from django.test import RequestFactory

from vds_form.django_view import create_submission_view
from vds_form.submission import TrustedSubmissionHandler, OperationRegistry, SimpleRbacEvaluator

HERE = os.path.dirname(__file__)
VALID = {"name": "Ada Lovelace", "email": "ada@example.com", "message": "Hello from the Django view."}


def _handler(rbac=None, security=None):
    ir = json.load(open(os.path.join(HERE, "fixtures", "ir", "contact.ir.json"), encoding="utf-8"))
    if security:
        ir.setdefault("security", {}).update(security)
    ops = OperationRegistry()
    ops.register("test:contact.create", lambda p, c: {"id": "rec-1", **p})
    return TrustedSubmissionHandler({"contact": ir}, ops, rbac=rbac)


def _csrf(request):
    """Attach a valid CSRF cookie+header pair using Django's public get_token().

    The view is CSRF-protected by default (Phase 1 security fix). These unit-style
    tests must therefore satisfy the CSRF boundary rather than bypass it; the
    rejection paths are covered in test_django_csrf.py through real middleware.
    """
    from django.conf import settings as dj_settings
    from django.middleware.csrf import get_token

    token = get_token(request)  # creates the secret in META["CSRF_COOKIE"]
    # Django reads the secret from the cookie (>=5.2) or META (older); set both
    # so the helper is portable across the supported Django matrix.
    request.COOKIES[dj_settings.CSRF_COOKIE_NAME] = request.META["CSRF_COOKIE"]
    request.META[dj_settings.CSRF_HEADER_NAME] = token
    return request


def _post(view, body, user=None):
    rf = RequestFactory()
    request = rf.post("/api/forms/submit", data=json.dumps(body), content_type="application/json")
    if user is not None:
        request.user = user
    return view(_csrf(request))


class _User:
    """Minimal authenticated principal stand-in for request.user."""
    def __init__(self, pk, perms=(), tenant_id=None):
        self.pk = pk
        self.is_authenticated = True
        self._perms = set(perms)
        self.tenant_id = tenant_id

    def get_all_permissions(self):
        return self._perms


def test_view_success_returns_200():
    view = create_submission_view(_handler())
    resp = _post(view, {"formId": "contact", "values": VALID, "idempotencyKey": "k", "correlationId": "c"})
    assert resp.status_code == 200
    assert json.loads(resp.content)["status"] == "succeeded"


def test_view_validation_failure_returns_422():
    view = create_submission_view(_handler())
    resp = _post(view, {"formId": "contact", "values": {"name": "A", "email": "bad", "message": "x"}, "idempotencyKey": "k", "correlationId": "c"})
    assert resp.status_code == 422
    assert json.loads(resp.content)["status"] == "server-validation-failed"


def test_view_rejects_auth_in_body():
    # P0: any attempt to supply authorization in the body is rejected outright.
    view = create_submission_view(_handler(rbac=SimpleRbacEvaluator(), security={"submitPermissions": ["contact:create"]}))
    resp = _post(view, {"formId": "contact", "values": VALID, "idempotencyKey": "k", "correlationId": "c",
                        "auth": {"userId": "attacker", "permissions": ["*"]}})
    assert resp.status_code == 400
    assert json.loads(resp.content)["code"] == "AUTH_IN_BODY_FORBIDDEN"


def test_view_gated_form_denies_anonymous():
    # No request.user → auth=None → fail-closed RBAC denies the gated form.
    view = create_submission_view(_handler(rbac=SimpleRbacEvaluator(), security={"submitPermissions": ["contact:create"]}))
    resp = _post(view, {"formId": "contact", "values": VALID, "idempotencyKey": "k", "correlationId": "c"})
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "PERMISSION_DENIED"


def test_view_gated_form_allows_authenticated_user_with_permission():
    view = create_submission_view(_handler(rbac=SimpleRbacEvaluator(), security={"submitPermissions": ["contact:create"]}))
    user = _User(pk=7, perms=["contact:create"])
    resp = _post(view, {"formId": "contact", "values": VALID, "idempotencyKey": "k", "correlationId": "c"}, user=user)
    assert resp.status_code == 200
    assert json.loads(resp.content)["status"] == "succeeded"


def test_view_gated_form_denies_authenticated_user_without_permission():
    view = create_submission_view(_handler(rbac=SimpleRbacEvaluator(), security={"submitPermissions": ["contact:create"]}))
    user = _User(pk=7, perms=[])
    resp = _post(view, {"formId": "contact", "values": VALID, "idempotencyKey": "k", "correlationId": "c"}, user=user)
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "PERMISSION_DENIED"


def test_view_auth_resolver_reads_verified_claims():
    # Host token-claims resolver is the ONLY source of auth besides request.user.
    def resolver(request):
        return {"userId": "token-user", "tenantId": "t9", "roles": [], "permissions": ["contact:create"]}
    view = create_submission_view(_handler(rbac=SimpleRbacEvaluator(), security={"submitPermissions": ["contact:create"]}), auth_resolver=resolver)
    resp = _post(view, {"formId": "contact", "values": VALID, "idempotencyKey": "k", "correlationId": "c"})
    assert resp.status_code == 200


def test_view_allow_anonymous_false_requires_auth():
    view = create_submission_view(_handler(), allow_anonymous=False)
    resp = _post(view, {"formId": "contact", "values": VALID, "idempotencyKey": "k", "correlationId": "c"})
    assert resp.status_code == 401
    assert json.loads(resp.content)["code"] == "AUTH_REQUIRED"


def test_view_rejects_non_post():
    view = create_submission_view(_handler())
    rf = RequestFactory()
    resp = view(rf.get("/api/forms/submit"))
    assert resp.status_code == 405


def test_view_rejects_invalid_json():
    view = create_submission_view(_handler())
    rf = RequestFactory()
    resp = view(_csrf(rf.post("/api/forms/submit", data="{not json", content_type="application/json")))
    assert resp.status_code == 400
