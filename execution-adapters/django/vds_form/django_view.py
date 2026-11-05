"""Thin Django integration for the trusted submission handler.

Django is imported lazily so the framework-free core (expressions, validation,
submission) can be conformance-tested without a Django project. Host projects
wire this view to a URL and register their real VDS Database/API operations.

SECURITY (audit P0): identity and permissions are derived EXCLUSIVELY from the
server-side authenticated principal (``request.user``) or a host-supplied
``auth_resolver`` that reads validated token claims. The request body is NEVER a
source of authorization: any body that contains an ``auth`` key is rejected with
400 AUTH_IN_BODY_FORBIDDEN. Unauthenticated requests carry ``auth=None`` and the
handler's fail-closed RBAC denies any permission-gated form.

SECURITY (CSRF, Phase 1): this view is **CSRF-protected by default**. It is wrapped
in ``csrf_protect``, which enforces Django's CSRF checks even if the host forgot to
install ``CsrfViewMiddleware``. Because identity may come from ``request.user``
(a cookie/session principal), an unprotected endpoint would accept cross-site
forged submissions; unconditional ``csrf_exempt`` was therefore removed.

Browser/session hosts must send a valid CSRF token (``X-CSRFToken`` header or the
``csrfmiddlewaretoken`` form field) exactly as for any other Django POST.

Non-cookie token hosts (e.g. ``Authorization: Bearer``) may opt out **explicitly**
with ``csrf_exempt_token_auth=True``. That is a host decision with hard conditions:

1. An ``auth_resolver`` MUST be supplied (otherwise wiring raises ``ValueError``),
   because with CSRF disabled the trusted resolver is the only identity source.
2. Identity is then taken ONLY from the resolver — ``request.user`` is never
   consulted on that route, so a session cookie can never grant authority there.
3. If a request presents the Django session cookie but the resolver yields no
   principal, the request is refused with 403 ``CSRF_SESSION_AUTH_FORBIDDEN``
   rather than silently downgraded to anonymous. Mount such routes on a
   token-only API surface, never on a cookie-authenticated browser surface.

Example (host urls.py):
    from vds_form.submission import TrustedSubmissionHandler, OperationRegistry
    from vds_form.django_view import create_submission_view
    ops = OperationRegistry()
    ops.register("database:contact.create", my_real_handler)
    handler = TrustedSubmissionHandler(forms={"contact": compiled_ir}, operations=ops, rbac=my_rbac)
    urlpatterns = [path("api/forms/submit", create_submission_view(handler))]

For token-based hosts, supply a resolver that reads VERIFIED claims, e.g.:
    def resolve(request):
        claims = request.auth  # populated by your authentication middleware
        return auth_context_from_claims(claims) if claims else None
    create_submission_view(handler, auth_resolver=resolve)
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, Optional

from .submission import TrustedSubmissionHandler

_STATUS_CODE = {
    "succeeded": 200,
    "server-validation-failed": 422,
    "permission-denied": 403,
    "business-rejected": 409,
    "config-error": 500,
}


def _auth_from_user(user: Any) -> Optional[Dict[str, Any]]:
    """Derive an auth context from Django's authenticated principal.

    ``userId``/``tenantId`` come from the user object; permissions default to the
    Django permission set. Hosts with custom VDS permission strings should supply
    an ``auth_resolver`` instead. Returns None for anonymous users.
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    perms = sorted(user.get_all_permissions()) if hasattr(user, "get_all_permissions") else []
    roles = []
    if hasattr(user, "groups"):
        try:
            roles = sorted(g.name for g in user.groups.all())
        except Exception:  # noqa: BLE001 — groups may be unavailable in some backends
            roles = []
    return {
        "userId": str(user.pk),
        "tenantId": getattr(user, "tenant_id", None),
        "roles": roles,
        "permissions": perms,
    }


def create_submission_view(
    handler: TrustedSubmissionHandler,
    auth_resolver: Optional[Callable[[Any], Optional[Dict[str, Any]]]] = None,
    allow_anonymous: bool = True,
    *,
    csrf_exempt_token_auth: bool = False,
) -> Callable:
    """Return a Django view that delegates to the trusted handler (POST, JSON).

    ``auth_resolver`` (optional) reads VERIFIED server-side claims and returns an
    auth context or None. If omitted, auth is derived from ``request.user``.
    ``allow_anonymous`` (default True) permits public forms; permission-gated
    forms are still denied anonymous by the handler's fail-closed RBAC.

    The view is CSRF-protected by default. ``csrf_exempt_token_auth=True`` is an
    explicit host opt-out for non-cookie token authentication only; it requires an
    ``auth_resolver`` and disables session-derived identity on that route. See the
    module docstring for the full conditions.
    """
    from django.conf import settings as dj_settings
    from django.http import JsonResponse, HttpResponseNotAllowed
    from django.views.decorators.csrf import csrf_exempt, csrf_protect

    if csrf_exempt_token_auth and auth_resolver is None:
        # Fail loudly at wiring time: disabling CSRF without a trusted resolver
        # would leave an endpoint with no identity source at all.
        raise ValueError(
            "csrf_exempt_token_auth=True requires an auth_resolver that reads verified "
            "token claims. CSRF exemption is only safe on a non-cookie token surface."
        )

    def view(request):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        try:
            body: Dict[str, Any] = json.loads(request.body or b"{}")
        except json.JSONDecodeError:
            return JsonResponse({"status": "config-error", "code": "INVALID_JSON", "message": "Request body must be JSON."}, status=400)
        if not isinstance(body, dict):
            return JsonResponse({"status": "config-error", "code": "INVALID_JSON", "message": "Request body must be a JSON object."}, status=400)

        # P0: the body must never carry authorization. Reject any such attempt.
        if "auth" in body:
            return JsonResponse({"status": "config-error", "code": "AUTH_IN_BODY_FORBIDDEN",
                                 "message": "Authorization must not be supplied in the request body."}, status=400)

        # Derive auth exclusively from the server-side principal / verified claims.
        if csrf_exempt_token_auth:
            # CSRF is off on this route, so the trusted resolver is the ONLY identity
            # source. Never fall back to the cookie/session principal here.
            auth = auth_resolver(request)
            if auth is None and request.COOKIES.get(dj_settings.SESSION_COOKIE_NAME):
                return JsonResponse(
                    {"status": "permission-denied", "code": "CSRF_SESSION_AUTH_FORBIDDEN",
                     "message": "This endpoint is token-only. Session-cookie authentication is not "
                                "accepted on a CSRF-exempt route; use the CSRF-protected endpoint."},
                    status=403,
                )
        else:
            auth = auth_resolver(request) if auth_resolver is not None else _auth_from_user(getattr(request, "user", None))
        if auth is None and not allow_anonymous:
            return JsonResponse({"status": "permission-denied", "code": "AUTH_REQUIRED",
                                 "message": "Authentication is required to submit this form."}, status=401)

        result = handler.handle({
            "formId": body.get("formId", ""),
            "formVersion": body.get("formVersion"),
            "values": body.get("values", {}),
            "operationRef": body.get("operationRef"),
            "idempotencyKey": body.get("idempotencyKey") or request.headers.get("Idempotency-Key", ""),
            "correlationId": body.get("correlationId") or request.headers.get("X-Correlation-Id", ""),
        }, auth)
        return JsonResponse(result, status=_STATUS_CODE.get(result["status"], 200))

    # Default: enforce CSRF even when the host omitted CsrfViewMiddleware.
    return csrf_exempt(view) if csrf_exempt_token_auth else csrf_protect(view)
