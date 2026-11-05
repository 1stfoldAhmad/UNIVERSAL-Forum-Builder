"""Django view integration for the server-rendered form renderer.

GET renders the form; POST submits through the trusted vds_form handler with a
SERVER-DERIVED principal (request.user / verified claims). The request body is
never a source of authorization. Supports no-JS urlencoded POST and JSON.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Callable, Dict, Optional

from vds_form.payload import build_payload
from vds_form.submission import TrustedSubmissionHandler
from vds_form.validation import compute_effective_state

from .html import render_page
from .parse import parse_form_values

_STATUS = {"succeeded": 200, "server-validation-failed": 422, "permission-denied": 403,
           "business-rejected": 409, "config-error": 500}


def _auth_from_user(user: Any) -> Optional[Dict[str, Any]]:
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    perms = sorted(user.get_all_permissions()) if hasattr(user, "get_all_permissions") else []
    return {"userId": str(user.pk), "tenantId": getattr(user, "tenant_id", None), "roles": [], "permissions": perms}


def create_form_view(handler: TrustedSubmissionHandler, irs: Dict[str, Dict[str, Any]],
                     auth_resolver: Optional[Callable[[Any], Optional[Dict[str, Any]]]] = None,
                     render_options: Optional[Dict[str, Any]] = None,
                     base_path: str = "/forms",
                     *,
                     csrf_exempt_token_auth: bool = False) -> Callable:
    """Server-rendered form view. CSRF-protected by default (Phase 1).

    The rendered ``<form>`` already embeds a ``csrfmiddlewaretoken`` hidden input;
    the view now actually VERIFIES it. ``csrf_exempt_token_auth=True`` is an
    explicit host opt-out for non-cookie token surfaces only and requires an
    ``auth_resolver``; see vds_form.django_view for the full conditions.
    """
    from django.conf import settings as dj_settings
    from django.http import HttpResponse, JsonResponse
    from django.views.decorators.csrf import csrf_exempt, csrf_protect

    if csrf_exempt_token_auth and auth_resolver is None:
        raise ValueError(
            "csrf_exempt_token_auth=True requires an auth_resolver that reads verified "
            "token claims. CSRF exemption is only safe on a non-cookie token surface."
        )

    opts = render_options or {}

    def view(request, form_id: str = ""):
        ir = irs.get(form_id)
        if ir is None:
            return JsonResponse({"status": "config-error", "code": "FORM_NOT_FOUND", "formId": form_id}, status=404)
        action = f"{base_path}/{form_id}"
        wants_json = request.GET.get("format") == "json" or "application/json" in request.headers.get("Accept", "")

        if request.method == "GET":
            return HttpResponse(render_page(ir, action=action, **opts))
        if request.method != "POST":
            return HttpResponse("Method not allowed", status=405)

        ctype = request.headers.get("Content-Type", "")
        if "application/json" in ctype:
            try:
                body = json.loads(request.body or b"{}")
            except json.JSONDecodeError:
                return JsonResponse({"status": "config-error", "code": "INVALID_JSON"}, status=400)
            if "auth" in body:
                return JsonResponse({"status": "config-error", "code": "AUTH_IN_BODY_FORBIDDEN"}, status=400)
            values = body.get("values", {})
            idempotency_key = body.get("idempotencyKey") or request.headers.get("Idempotency-Key", "")
        else:
            values = parse_form_values(ir, dict(request.POST.lists()), csrf_param=opts.get("csrf_param", "csrfmiddlewaretoken"))
            idempotency_key = request.POST.get("_idempotencyKey", "") or request.headers.get("Idempotency-Key", "")
        if not idempotency_key:
            idempotency_key = f"django-{uuid.uuid4().hex}"

        if csrf_exempt_token_auth:
            auth = auth_resolver(request)
            if auth is None and request.COOKIES.get(dj_settings.SESSION_COOKIE_NAME):
                return JsonResponse({"status": "permission-denied", "code": "CSRF_SESSION_AUTH_FORBIDDEN"}, status=403)
        else:
            auth = auth_resolver(request) if auth_resolver is not None else _auth_from_user(getattr(request, "user", None))
        state, _ = compute_effective_state(ir, values)
        payload, issues = build_payload(ir, values, state, ir.get("submission", {})) if ir.get("submission") else (values, [])
        errors = [i for i in issues if i["severity"] == "error"]
        if errors:
            result = {"status": "server-validation-failed", "issues": errors}
        else:
            result = handler.handle({"formId": form_id, "values": payload, "idempotencyKey": idempotency_key,
                                     "correlationId": request.headers.get("X-Correlation-Id", "")}, auth)

        if wants_json or "application/json" in ctype:
            return JsonResponse(result, status=_STATUS.get(result["status"], 200))
        if result["status"] == "succeeded":
            page = render_page(ir, values=values, action=action, **opts)
            return HttpResponse(page.replace("<form", '<p class="vds-success" role="status" data-vds-status>Submitted successfully.</p><form', 1))
        issues = result.get("issues", []) if result["status"] == "server-validation-failed" else []
        status = _STATUS.get(result["status"], 409)
        if not issues:
            return HttpResponse(f'<p class="vds-error" role="alert">{result.get("message", result["status"])}</p>', status=status)
        return HttpResponse(render_page(ir, values=values, issues=issues, action=action, **opts), status=status)

    return csrf_exempt(view) if csrf_exempt_token_auth else csrf_protect(view)
