"""
Trusted server-side submission handler — Python port of
execution-adapters/node. Re-validates and re-authorizes EVERY submission;
client-side hiding is never authorization. Operations resolve against a
registered OperationRegistry (VDS Database/API Builder contracts) — there is no
generic endpoint and no fake submit(). Missing operations fail with
SUBMISSION_OPERATION_UNRESOLVED. Audit records value PATHS only, never values.

The handler operates on the deterministic FormIR (shared cross-language
contract). Hosts compile once with the TS compiler (`vds-form compile --json`)
and register the resulting IR here.
"""
from __future__ import annotations

import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from .expressions import get_path
from .validation import compute_effective_state, validate_values


def set_in(root: Any, path: str, value: Any) -> Any:
    """Immutable set by dot path; numeric segments index lists (port of refs.setIn)."""
    segments = path.split(".")

    def recur(node: Any, i: int) -> Any:
        if i == len(segments):
            return value
        seg = segments[i]
        if re.fullmatch(r"\d+", seg):
            arr = list(node) if isinstance(node, list) else []
            idx = int(seg)
            while len(arr) <= idx:
                arr.append(None)
            arr[idx] = recur(arr[idx], i + 1)
            return arr
        obj = dict(node) if isinstance(node, dict) else {}
        obj[seg] = recur(obj.get(seg), i + 1)
        return obj

    return recur(root, 0)


class OperationRegistry:
    def __init__(self) -> None:
        self._handlers: Dict[str, Callable] = {}

    def register(self, operation_ref: str, handler: Callable) -> None:
        if operation_ref in self._handlers:
            raise ValueError(f"OPERATION_DUPLICATE: {operation_ref}")
        self._handlers[operation_ref] = handler

    def has(self, operation_ref: str) -> bool:
        return operation_ref in self._handlers

    def resolve(self, operation_ref: str) -> Optional[Callable]:
        return self._handlers.get(operation_ref)

    def refs(self) -> List[str]:
        return sorted(self._handlers.keys())


class SimpleRbacEvaluator:
    """Permission-subset evaluator (host projects replace with their policy engine)."""

    def evaluate(self, auth: Optional[Dict[str, Any]], required: List[str]) -> Dict[str, Any]:
        granted = set((auth or {}).get("permissions", []))
        if "*" in granted:
            return {"allowed": True, "missing": []}
        missing = [p for p in required if p not in granted]
        return {"allowed": not missing, "missing": missing}


def _server_issue(code: str, message: str, path: str = "") -> Dict[str, Any]:
    return {"code": code, "message": message, "path": path, "severity": "error", "source": "server"}


class TrustedSubmissionHandler:
    def __init__(self, forms: Dict[str, Dict[str, Any]], operations: OperationRegistry,
                 rbac: Any = None, audit: Optional[Callable[[Dict[str, Any]], None]] = None,
                 idempotency_store: Optional[Dict[str, Any]] = None) -> None:
        self.irs: Dict[str, Dict[str, Any]] = {}
        self.operations = operations
        self.rbac = rbac
        self.audit = audit
        self.idempotency = idempotency_store if idempotency_store is not None else {}
        for form_id, ir in forms.items():
            if "irVersion" not in ir:
                raise ValueError(f"FORM_IR_REQUIRED ({form_id}): register a compiled FormIR (vds-form compile --json), not a raw document.")
            self.irs[form_id] = ir

    def supports_operation(self, operation_ref: str) -> bool:
        return self.operations.has(operation_ref)

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        started = time.time()
        ir = self.irs.get(request["formId"])
        if ir is None:
            return {"status": "config-error", "code": "SUBMISSION_OPERATION_UNRESOLVED",
                    "message": f"Form \"{request['formId']}\" is not registered on this server."}
        submission = ir.get("submission") or {}
        operation_ref = request.get("operationRef") or submission.get("operationRef") or ""
        req_values = request.get("values", {})

        def do_audit(result: Dict[str, Any], issue_codes: Optional[List[str]] = None) -> None:
            if not self.audit:
                return
            self.audit({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "formId": ir["formId"], "formVersion": ir["formVersion"],
                "operationRef": operation_ref, "correlationId": request.get("correlationId", ""),
                "idempotencyKey": request["idempotencyKey"],
                "userId": (request.get("auth") or {}).get("userId"),
                "tenantId": (request.get("auth") or {}).get("tenantId"),
                "outcome": result["status"], "issueCodes": issue_codes or [],
                "valuePaths": list(req_values.keys()),  # paths only, never values
            })

        cache_key = f"{request['formId']}|{request['idempotencyKey']}"
        cached = self.idempotency.get(cache_key)
        if cached is not None:
            do_audit(cached, ["IDEMPOTENT_REPLAY"])
            return cached

        if request.get("formVersion") and request["formVersion"] != ir["formVersion"]:
            result = {"status": "server-validation-failed",
                      "issues": [_server_issue("FORM_VERSION_MISMATCH", f"Client form version {request['formVersion']} != server {ir['formVersion']}.")]}
            do_audit(result, ["FORM_VERSION_MISMATCH"])
            return result

        # Reverse inputMapping to reconstruct field-keyed values.
        mapping = submission.get("inputMapping")
        if mapping:
            values: Dict[str, Any] = {}
            for param, source_path in mapping.items():
                if param in req_values:
                    values = set_in(values, source_path, req_values[param])
        else:
            values = req_values

        state, _ = compute_effective_state(ir, values)
        validation = validate_values(ir, values, state, phase="submit")
        if not validation["valid"]:
            issues = [{**i, "source": "server"} for i in validation["issues"]]
            result = {"status": "server-validation-failed", "issues": issues}
            do_audit(result, [i["code"] for i in validation["issues"]])
            return result

        security = ir.get("security", {})
        required = security.get("submitPermissions") or []
        if required:
            if self.rbac is None:
                result = {"status": "permission-denied", "code": "RBAC_NOT_CONFIGURED",
                          "message": "Form declares submitPermissions but no RBAC evaluator is registered on the server.",
                          "requiredPermissions": required}
                do_audit(result, ["RBAC_NOT_CONFIGURED"])
                return result
            decision = self.rbac.evaluate(request.get("auth"), required)
            if not decision["allowed"]:
                result = {"status": "permission-denied", "code": "PERMISSION_DENIED",
                          "message": f"Missing permissions: {', '.join(decision['missing'])}",
                          "requiredPermissions": decision["missing"]}
                do_audit(result, ["PERMISSION_DENIED"])
                return result

        for field_id, access in (security.get("fieldAccess") or {}).items():
            write_perms = access.get("write") or []
            if not write_perms:
                continue
            field = next((f for f in ir["fields"] if f["id"] == field_id), None)
            if field is None:
                continue
            provided = get_path(values, field["key"])
            if provided is None:
                continue
            decision = self.rbac.evaluate(request.get("auth"), write_perms) if self.rbac else {"allowed": False, "missing": write_perms}
            if not decision["allowed"]:
                result = {"status": "permission-denied", "code": "FIELD_WRITE_DENIED",
                          "message": f"Not permitted to write field \"{field['key']}\".",
                          "requiredPermissions": decision["missing"]}
                do_audit(result, ["FIELD_WRITE_DENIED"])
                return result

        handler = self.operations.resolve(operation_ref)
        if handler is None:
            result = {"status": "config-error", "code": "SUBMISSION_OPERATION_UNRESOLVED",
                      "message": f"Operation \"{operation_ref}\" is not registered on this server."}
            do_audit(result, ["SUBMISSION_OPERATION_UNRESOLVED"])
            return result

        try:
            data = handler(req_values, {
                "auth": request.get("auth"), "idempotencyKey": request["idempotencyKey"],
                "correlationId": request.get("correlationId", ""), "formId": ir["formId"],
            })
            result = {"status": "succeeded", "operationRef": operation_ref, "data": data,
                      "idempotencyKey": request["idempotencyKey"], "durationMs": int((time.time() - started) * 1000)}
        except Exception as e:  # noqa: BLE001 — operation errors become structured results
            issues = getattr(e, "issues", None)
            code = getattr(e, "code", None)
            if issues:
                result = {"status": "server-validation-failed", "issues": [{**i, "source": "server"} for i in issues]}
            elif code == "PERMISSION_DENIED":
                result = {"status": "permission-denied", "code": code, "message": str(e) or "Denied by operation."}
            else:
                result = {"status": "business-rejected", "code": code or "OPERATION_FAILED", "message": str(e) or "Operation failed."}

        if result["status"] == "succeeded":
            self.idempotency[cache_key] = result
        do_audit(result, [i["code"] for i in result.get("issues", [])])
        return result


def auth_context_from_claims(claims: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "userId": claims.get("sub"), "tenantId": claims.get("tenant_id"),
        "roles": claims.get("roles", []), "permissions": claims.get("permissions", []),
        "sessionId": claims.get("sid"),
    }
