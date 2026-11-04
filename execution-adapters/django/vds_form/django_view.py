"""
Thin Django integration for the trusted submission handler.

Django is imported lazily so the framework-free core (expressions, validation,
submission) can be conformance-tested without a Django project. Host projects
wire this view to a URL and register their real VDS Database/API operations.

Example (host urls.py):
    from vds_form.submission import TrustedSubmissionHandler, OperationRegistry
    from vds_form.django_view import create_submission_view
    ops = OperationRegistry()
    ops.register("database:contact.create", my_real_handler)
    handler = TrustedSubmissionHandler(forms={"contact": compiled_ir}, operations=ops, rbac=my_rbac)
    urlpatterns = [path("api/forms/submit", create_submission_view(handler))]
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict

from .submission import TrustedSubmissionHandler

_STATUS_CODE = {
    "succeeded": 200,
    "server-validation-failed": 422,
    "permission-denied": 403,
    "business-rejected": 409,
    "config-error": 500,
}


def create_submission_view(handler: TrustedSubmissionHandler) -> Callable:
    """Return a Django view that delegates to the trusted handler (POST, JSON)."""
    from django.http import JsonResponse, HttpResponseNotAllowed
    from django.views.decorators.csrf import csrf_exempt

    @csrf_exempt
    def view(request):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        try:
            body: Dict[str, Any] = json.loads(request.body or b"{}")
        except json.JSONDecodeError:
            return JsonResponse({"status": "config-error", "code": "INVALID_JSON", "message": "Request body must be JSON."}, status=400)

        # Derive auth from the host's authenticated session/claims if present.
        auth = body.get("auth")
        if auth is None and getattr(request, "user", None) is not None and request.user.is_authenticated:
            auth = {
                "userId": str(request.user.pk),
                "permissions": sorted(request.user.get_all_permissions()) if hasattr(request.user, "get_all_permissions") else [],
            }

        result = handler.handle({
            "formId": body.get("formId", ""),
            "formVersion": body.get("formVersion"),
            "values": body.get("values", {}),
            "operationRef": body.get("operationRef"),
            "auth": auth,
            "idempotencyKey": body.get("idempotencyKey") or request.headers.get("Idempotency-Key", ""),
            "correlationId": body.get("correlationId") or request.headers.get("X-Correlation-Id", ""),
        })
        return JsonResponse(result, status=_STATUS_CODE.get(result["status"], 200))

    return view
