"""Phase 1 — CSRF boundary tests through REAL Django middleware.

These use ``django.test.Client(enforce_csrf_checks=True)`` against a real URLconf
with Session → Authentication → CsrfViewMiddleware installed, so Django's actual
CSRF machinery decides the outcome. Calling the handler directly would not prove
anything about CSRF, which is why the previous csrf_exempt defect was invisible.
"""
from __future__ import annotations

import json
import uuid

import pytest

django = pytest.importorskip("django")

from django.contrib.auth.models import Group, User  # noqa: E402
from django.test import Client  # noqa: E402

from vds_form.django_view import create_submission_view  # noqa: E402

import django_urls as app  # noqa: E402

VALID = app.VALID


def _body(key=None, **extra):
    body = {"formId": "contact", "values": VALID,
            "idempotencyKey": key or f"k-{uuid.uuid4()}", "correlationId": "c-csrf"}
    body.update(extra)
    return body


def _post(client, url, body, token=None, **headers):
    if token is not None:
        headers["HTTP_X_CSRFTOKEN"] = token
    return client.post(url, data=json.dumps(body), content_type="application/json", **headers)


def _csrf(client):
    return json.loads(client.get("/csrf-token").content)["csrfToken"]


def _login(client, username, *, submitter=False):
    user = User.objects.create_user(username=username, password="pw")
    if submitter:
        group, _ = Group.objects.get_or_create(name="contact-submitters")
        user.groups.add(group)
    client.force_login(user)
    return user


# --- 1. session-authenticated + valid CSRF token -------------------------------
def test_session_auth_with_valid_csrf_token_succeeds(django_db):
    client = Client(enforce_csrf_checks=True)
    _login(client, "csrf-ok", submitter=True)
    resp = _post(client, "/submit-gated-session", _body(), token=_csrf(client))
    assert resp.status_code == 200
    assert json.loads(resp.content)["status"] == "succeeded"


# --- 2. session-authenticated, NO CSRF token ----------------------------------
def test_session_auth_without_csrf_token_is_rejected(django_db):
    client = Client(enforce_csrf_checks=True)
    _login(client, "csrf-missing", submitter=True)
    before = len(app.CALLS)
    resp = _post(client, "/submit-gated-session", _body())
    assert resp.status_code == 403
    # The trusted operation must never run for a CSRF-rejected request.
    assert len(app.CALLS) == before


# --- 3. invalid CSRF token ----------------------------------------------------
def test_session_auth_with_invalid_csrf_token_is_rejected(django_db):
    client = Client(enforce_csrf_checks=True)
    _login(client, "csrf-bad", submitter=True)
    _csrf(client)  # establishes the CSRF cookie
    before = len(app.CALLS)
    resp = _post(client, "/submit-gated-session", _body(), token="not-the-real-token")
    assert resp.status_code == 403
    assert len(app.CALLS) == before


# --- 4. valid token-authenticated request (explicit CSRF exemption) -----------
def test_token_auth_request_succeeds_without_csrf(django_db):
    client = Client(enforce_csrf_checks=True)
    before = len(app.CALLS)
    resp = _post(client, "/submit-token", _body(), HTTP_AUTHORIZATION="Bearer token-with-permission")
    assert resp.status_code == 200
    assert json.loads(resp.content)["status"] == "succeeded"
    # Identity came from the verified token claims, not from any cookie.
    assert app.CALLS[-1]["context"]["auth"]["userId"] == "token-user"
    assert len(app.CALLS) == before + 1


# --- 5. forged body auth ------------------------------------------------------
def test_forged_body_auth_is_rejected_on_protected_route(django_db):
    client = Client(enforce_csrf_checks=True)
    _login(client, "csrf-forge", submitter=True)
    before = len(app.CALLS)
    resp = _post(client, "/submit-gated-session",
                 _body(auth={"userId": "attacker", "permissions": ["*"]}), token=_csrf(client))
    assert resp.status_code == 400
    assert json.loads(resp.content)["code"] == "AUTH_IN_BODY_FORBIDDEN"
    assert len(app.CALLS) == before


def test_forged_body_auth_is_rejected_on_token_route(django_db):
    client = Client(enforce_csrf_checks=True)
    before = len(app.CALLS)
    resp = _post(client, "/submit-token",
                 _body(auth={"userId": "attacker", "permissions": ["*"]}),
                 HTTP_AUTHORIZATION="Bearer token-without-permission")
    assert resp.status_code == 400
    assert json.loads(resp.content)["code"] == "AUTH_IN_BODY_FORBIDDEN"
    assert len(app.CALLS) == before


# --- 6. anonymous public form -------------------------------------------------
def test_anonymous_public_form_succeeds_with_csrf_token(django_db):
    client = Client(enforce_csrf_checks=True)
    resp = _post(client, "/submit", _body(), token=_csrf(client))
    assert resp.status_code == 200
    assert json.loads(resp.content)["status"] == "succeeded"
    assert app.CALLS[-1]["context"]["auth"] is None


def test_anonymous_public_form_still_requires_csrf(django_db):
    # CSRF applies to unsafe methods regardless of authentication state.
    client = Client(enforce_csrf_checks=True)
    resp = _post(client, "/submit", _body())
    assert resp.status_code == 403


# --- 7. anonymous protected form ---------------------------------------------
def test_anonymous_protected_form_is_denied(django_db):
    client = Client(enforce_csrf_checks=True)
    resp = _post(client, "/submit-gated-session", _body(), token=_csrf(client))
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "PERMISSION_DENIED"


def test_allow_anonymous_false_returns_401(django_db):
    client = Client(enforce_csrf_checks=True)
    resp = _post(client, "/submit-noanon", _body(), token=_csrf(client))
    assert resp.status_code == 401
    assert json.loads(resp.content)["code"] == "AUTH_REQUIRED"


# --- 8. missing permissions ---------------------------------------------------
def test_session_user_without_permission_is_denied(django_db):
    client = Client(enforce_csrf_checks=True)
    _login(client, "csrf-noperm", submitter=False)
    resp = _post(client, "/submit-gated-session", _body(), token=_csrf(client))
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "PERMISSION_DENIED"


def test_token_without_permission_is_denied(django_db):
    client = Client(enforce_csrf_checks=True)
    resp = _post(client, "/submit-token", _body(), HTTP_AUTHORIZATION="Bearer token-without-permission")
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "PERMISSION_DENIED"


def test_default_django_principal_derivation_denies_without_vds_permission(django_db):
    # No resolver: identity comes from request.user, whose Django permission set
    # does not contain the colon-scoped VDS permission -> fail closed.
    client = Client(enforce_csrf_checks=True)
    _login(client, "csrf-default-derive", submitter=True)
    resp = _post(client, "/submit-gated", _body(), token=_csrf(client))
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "PERMISSION_DENIED"


# --- 9. tenant isolation ------------------------------------------------------
def test_idempotency_key_is_tenant_scoped(django_db):
    key = f"shared-{uuid.uuid4()}"
    client_a = Client(enforce_csrf_checks=True)
    resp_a = _post(client_a, "/submit-token", _body(key), HTTP_AUTHORIZATION="Bearer token-with-permission")
    assert resp_a.status_code == 200
    record_a = json.loads(resp_a.content)["data"]["id"]
    tenant_a = app.CALLS[-1]["context"]["auth"]["tenantId"]

    client_b = Client(enforce_csrf_checks=True)
    resp_b = _post(client_b, "/submit-token", _body(key), HTTP_AUTHORIZATION="Bearer token-tenant-b")
    assert resp_b.status_code == 200
    record_b = json.loads(resp_b.content)["data"]["id"]
    tenant_b = app.CALLS[-1]["context"]["auth"]["tenantId"]

    # Same raw key, different tenant -> a NEW execution, never tenant A's record.
    assert tenant_a == "t-token" and tenant_b == "t-other"
    assert record_a != record_b


def test_same_tenant_replay_is_idempotent(django_db):
    key = f"replay-{uuid.uuid4()}"
    client = Client(enforce_csrf_checks=True)
    first = _post(client, "/submit-token", _body(key), HTTP_AUTHORIZATION="Bearer token-with-permission")
    before = len(app.CALLS)
    second = _post(client, "/submit-token", _body(key), HTTP_AUTHORIZATION="Bearer token-with-permission")
    assert first.status_code == second.status_code == 200
    assert json.loads(first.content)["data"] == json.loads(second.content)["data"]
    assert len(app.CALLS) == before  # replay did not re-execute


# --- CSRF-exemption hardening -------------------------------------------------
def test_csrf_exempt_token_auth_requires_a_resolver():
    with pytest.raises(ValueError, match="auth_resolver"):
        create_submission_view(app.PUBLIC, csrf_exempt_token_auth=True)


def test_session_cookie_cannot_ride_the_csrf_exempt_route(django_db):
    # A browser session (even a privileged one) must not gain authority on the
    # token-only route; without a bearer token the request is refused outright.
    client = Client(enforce_csrf_checks=True)
    _login(client, "csrf-ride", submitter=True)
    before = len(app.CALLS)
    resp = _post(client, "/submit-token", _body())
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "CSRF_SESSION_AUTH_FORBIDDEN"
    assert len(app.CALLS) == before


def test_csrf_protection_applies_even_without_csrf_middleware():
    # Defense in depth: csrf_protect enforces the check even if the host forgot
    # to install CsrfViewMiddleware. RequestFactory bypasses middleware entirely.
    from django.test import RequestFactory

    view = create_submission_view(app.PUBLIC)
    request = RequestFactory().post("/submit", data=json.dumps(_body()), content_type="application/json")
    assert view(request).status_code == 403


def test_unknown_bearer_token_is_anonymous_and_denied(django_db):
    client = Client(enforce_csrf_checks=True)
    resp = _post(client, "/submit-token", _body(), HTTP_AUTHORIZATION="Bearer forged-token")
    assert resp.status_code == 403
    assert json.loads(resp.content)["code"] == "PERMISSION_DENIED"
