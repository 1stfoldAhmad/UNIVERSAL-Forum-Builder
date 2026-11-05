"""Real URLconf used by the middleware-level view tests.

These routes mirror how a host project wires the adapter. The token resolver is a
**TEST** resolver: it maps a fixed bearer token to verified claims and stands in
for the host's real authentication middleware. It is never a production provider.
"""
from __future__ import annotations

import json
import os

from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.urls import path

from vds_form.django_view import create_submission_view
from vds_form.submission import OperationRegistry, SimpleRbacEvaluator, TrustedSubmissionHandler

HERE = os.path.dirname(__file__)
IR = json.load(open(os.path.join(HERE, "fixtures", "ir", "contact.ir.json"), encoding="utf-8"))

VALID = {"name": "Ada Lovelace", "email": "ada@example.com", "message": "Hello from the Django view."}

# Records what the trusted operation actually received, so tests can assert that
# identity/tenant came from the server principal and never from the body.
CALLS: list = []


def _operation(payload, context):
    CALLS.append({"payload": payload, "context": context})
    return {"id": f"rec-{len(CALLS)}", **payload}


def _handler(security=None):
    ops = OperationRegistry()
    ops.register("test:contact.create", _operation)
    ir = json.loads(json.dumps(IR))
    if security:
        ir.setdefault("security", {}).update(security)
    return TrustedSubmissionHandler({"contact": ir}, ops, rbac=SimpleRbacEvaluator())


PUBLIC = _handler()
GATED = _handler({"submitPermissions": ["contact:create"]})

# TEST bearer resolver — stands in for verified host token claims.
TEST_TOKENS = {
    "token-with-permission": {"userId": "token-user", "tenantId": "t-token", "roles": [], "permissions": ["contact:create"]},
    "token-without-permission": {"userId": "token-user-2", "tenantId": "t-token", "roles": [], "permissions": []},
    "token-tenant-b": {"userId": "token-user-b", "tenantId": "t-other", "roles": [], "permissions": ["contact:create"]},
}


def session_resolver(request):
    """Host-style resolver mapping a real Django session principal to VDS claims.

    Django's own permission strings are ``app_label.codename``; VDS permissions
    are colon-scoped, so hosts map them explicitly (here: group membership).
    """
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated:
        return None
    groups = [g.name for g in user.groups.all()]
    return {
        "userId": str(user.pk),
        "tenantId": "t-session",
        "roles": groups,
        "permissions": ["contact:create"] if "contact-submitters" in groups else [],
    }


def bearer_resolver(request):
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    claims = TEST_TOKENS.get(header[len("Bearer "):])
    return dict(claims) if claims else None


def csrf_token_view(request):
    """GET endpoint that issues a CSRF token + cookie for browser-style tests."""
    return JsonResponse({"csrfToken": get_token(request)})


urlpatterns = [
    path("csrf-token", csrf_token_view),
    path("submit", create_submission_view(PUBLIC)),
    path("submit-gated", create_submission_view(GATED)),
    path("submit-noanon", create_submission_view(PUBLIC, allow_anonymous=False)),
    path("submit-resolver", create_submission_view(GATED, auth_resolver=bearer_resolver)),
    path("submit-gated-session", create_submission_view(GATED, auth_resolver=session_resolver)),
    path("submit-token", create_submission_view(GATED, auth_resolver=bearer_resolver, csrf_exempt_token_auth=True)),
]
