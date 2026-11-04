"""Trusted server-side submission handler — Python port of
execution-adapters/node. Re-validates and re-authorizes EVERY submission;
client-side hiding is never authorization. Operations resolve against a
registered OperationRegistry (VDS Database/API Builder contracts) — there is no
generic endpoint and no fake submit(). Missing operations fail with
SUBMISSION_OPERATION_UNRESOLVED. Audit records value PATHS only, never values.

SECURITY BOUNDARY (audit P0/P1), identical to the Node adapter:
- ``auth`` is a SEPARATE, server-derived argument, never read from the client
  request payload. The Django view derives it from request.user / validated
  token claims — never from the body.
- The executed operation is bound to the compiled FormIR (and an optional
  server-side allowlist); a client cannot select or override it.
- Idempotency is checked only AFTER authentication, authorization and version
  checks; keys are scoped by tenant+user+form+operation and carry a canonical
  payload fingerprint; claims are atomic. See idempotency.py.

The handler operates on the deterministic FormIR (shared cross-language
contract). Hosts compile once with the TS compiler (`vds-form compile --json`)
and register the resulting IR here.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from .expressions import get_path
from .validation import compute_effective_state, expand_field_instances, validate_values
from .payload import build_payload
from .policy import compute_read_policy, filter_readable_values, prepare_submission_values
from .idempotency import (
    InMemoryIdempotencyStore, payload_fingerprint, scoped_idempotency_key,
)


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


def _has_path(root: Any, path: str) -> bool:
    cur: Any = root
    for part in path.split("."):
        if isinstance(cur, list):
            if not part.isdigit() or int(part) >= len(cur):
                return False
            cur = cur[int(part)]
        elif isinstance(cur, dict):
            if part not in cur:
                return False
            cur = cur[part]
        else:
            return False
    return True


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
                 idempotency_store: Any = None,
                 allowed_operations: Optional[List[str]] = None) -> None:
        self.irs: Dict[str, Dict[str, Any]] = {}
        self.operations = operations
        self.rbac = rbac
        self.audit = audit
        self.idempotency = idempotency_store if idempotency_store is not None else InMemoryIdempotencyStore()
        self.allowed_operations = set(allowed_operations) if allowed_operations is not None else None
        for form_id, ir in forms.items():
            if "irVersion" not in ir:
                raise ValueError(f"FORM_IR_REQUIRED ({form_id}): register a compiled FormIR (vds-form compile --json), not a raw document.")
            self.irs[form_id] = ir

    def supports_operation(self, operation_ref: str) -> bool:
        return self.operations.has(operation_ref)

    def handle(self, request: Dict[str, Any], auth: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Handle a submission. ``auth`` is the SERVER-DERIVED principal; it must
        never be taken from the client request body."""
        started = time.time()
        ir = self.irs.get(request["formId"])
        if ir is None:
            return {"status": "config-error", "code": "SUBMISSION_OPERATION_UNRESOLVED",
                    "message": f"Form \"{request['formId']}\" is not registered on this server."}
        submission = ir.get("submission") or {}
        req_values = request.get("values", {})

        def do_audit(result: Dict[str, Any], operation_ref: str, issue_codes: Optional[List[str]] = None) -> None:
            if not self.audit:
                return
            self.audit({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "formId": ir["formId"], "formVersion": ir["formVersion"],
                "operationRef": operation_ref, "correlationId": request.get("correlationId", ""),
                "idempotencyKey": request["idempotencyKey"],
                "userId": (auth or {}).get("userId"),
                "tenantId": (auth or {}).get("tenantId"),
                "outcome": result["status"], "issueCodes": issue_codes or [],
                "valuePaths": list(req_values.keys()),  # paths only, never values
            })

        # Operation binding: from the compiled FormIR, never from the client.
        operation_ref = submission.get("operationRef") or ""
        if request.get("operationRef") is not None and request["operationRef"] != operation_ref:
            result = {"status": "permission-denied", "code": "OPERATION_OVERRIDE_FORBIDDEN",
                      "message": "The requested operation does not match the operation configured for this form."}
            do_audit(result, operation_ref, ["OPERATION_OVERRIDE_FORBIDDEN"])
            return result
        if self.allowed_operations is not None and operation_ref not in self.allowed_operations:
            result = {"status": "permission-denied", "code": "OPERATION_NOT_ALLOWED",
                      "message": f"Operation \"{operation_ref}\" is not in the server allowlist."}
            do_audit(result, operation_ref, ["OPERATION_NOT_ALLOWED"])
            return result

        if request.get("formVersion") and request["formVersion"] != ir["formVersion"]:
            result = {"status": "server-validation-failed",
                      "issues": [_server_issue("FORM_VERSION_MISMATCH", f"Client form version {request['formVersion']} != server {ir['formVersion']}.")]}
            do_audit(result, operation_ref, ["FORM_VERSION_MISMATCH"])
            return result

        # Reverse inputMapping to reconstruct field-keyed values for state, then
        # apply the strict submission policy (unknown roots, hidden descendants,
        # typed operation inputs) before validation/execution.
        mapping = submission.get("inputMapping")
        if mapping:
            raw_values: Dict[str, Any] = {}
            for param, source_path in mapping.items():
                if param in req_values:
                    raw_values = set_in(raw_values, source_path, req_values[param])
        else:
            raw_values = req_values if isinstance(req_values, dict) else {}

        state, _ = compute_effective_state(ir, raw_values)
        prepared = prepare_submission_values(ir, req_values, state.get("visibility", {}))
        if prepared["issues"]:
            issues = [{**i, "source": "server"} for i in prepared["issues"]]
            result = {"status": "server-validation-failed", "issues": issues}
            do_audit(result, operation_ref, [i["code"] for i in issues])
            return result
        values = prepared["fieldValues"]
        validation = validate_values(ir, values, state, phase="submit")
        if not validation["valid"]:
            issues = [{**i, "source": "server"} for i in validation["issues"]]
            result = {"status": "server-validation-failed", "issues": issues}
            do_audit(result, operation_ref, [i["code"] for i in validation["issues"]])
            return result

        security = ir.get("security", {})
        required = security.get("submitPermissions") or []
        if required:
            if self.rbac is None:
                result = {"status": "permission-denied", "code": "RBAC_NOT_CONFIGURED",
                          "message": "Form declares submitPermissions but no RBAC evaluator is registered on the server.",
                          "requiredPermissions": required}
                do_audit(result, operation_ref, ["RBAC_NOT_CONFIGURED"])
                return result
            decision = self.rbac.evaluate(auth, required)
            if not decision["allowed"]:
                result = {"status": "permission-denied", "code": "PERMISSION_DENIED",
                          "message": f"Missing permissions: {', '.join(decision['missing'])}",
                          "requiredPermissions": decision["missing"]}
                do_audit(result, operation_ref, ["PERMISSION_DENIED"])
                return result

        for field_id, access in (security.get("fieldAccess") or {}).items():
            write_perms = access.get("write") or []
            if not write_perms:
                continue
            field = next((f for f in ir["fields"] if f["id"] == field_id), None)
            if field is None:
                continue
            instances = [i for i in expand_field_instances(ir, values) if i["field"]["id"] == field_id]
            paths = [i["concreteKey"] for i in instances] if instances else [field["key"]]
            for path in paths:
                if not _has_path(values, path):
                    continue
                decision = self.rbac.evaluate(auth, write_perms) if self.rbac else {"allowed": False, "missing": write_perms}
                if not decision["allowed"]:
                    result = {"status": "permission-denied", "code": "FIELD_WRITE_DENIED",
                              "message": f"Not permitted to write field \"{path}\".",
                              "requiredPermissions": decision["missing"]}
                    do_audit(result, operation_ref, ["FIELD_WRITE_DENIED"])
                    return result

        read_policy = compute_read_policy(ir, auth, self.rbac)

        payload_values = {**values, **prepared["operationInputs"]}
        payload, payload_issues = build_payload(ir, payload_values, state, submission)
        if any(i["severity"] == "error" for i in payload_issues):
            issues = [{**i, "source": "server"} for i in payload_issues]
            result = {"status": "server-validation-failed", "issues": issues}
            do_audit(result, operation_ref, [i["code"] for i in issues])
            return result

        handler = self.operations.resolve(operation_ref)
        if handler is None:
            result = {"status": "config-error", "code": "SUBMISSION_OPERATION_UNRESOLVED",
                      "message": f"Operation \"{operation_ref}\" is not registered on this server."}
            do_audit(result, operation_ref, ["SUBMISSION_OPERATION_UNRESOLVED"])
            return result

        # Idempotency AFTER auth/authz/version. Scoped key + fingerprint + atomic claim.
        scope_key = scoped_idempotency_key(
            tenant_id=(auth or {}).get("tenantId"), user_id=(auth or {}).get("userId"),
            form_id=ir["formId"], operation_ref=operation_ref,
            idempotency_key=request["idempotencyKey"],
        )
        fingerprint = payload_fingerprint(req_values)
        claim = self.idempotency.claim(scope_key, fingerprint)
        if claim["kind"] == "replay":
            replay_result = claim["result"]
            if replay_result.get("status") == "succeeded" and isinstance(replay_result.get("data"), dict):
                replay_result = {**replay_result, "data": filter_readable_values(ir, replay_result["data"], read_policy["denied"])}
            do_audit(replay_result, operation_ref, ["IDEMPOTENT_REPLAY"])
            return replay_result
        if claim["kind"] == "conflict":
            result = {"status": "business-rejected", "code": "IDEMPOTENCY_KEY_CONFLICT",
                      "message": "This idempotency key was already used with a different payload."}
            do_audit(result, operation_ref, ["IDEMPOTENCY_KEY_CONFLICT"])
            return result
        if claim["kind"] == "in-progress":
            result = {"status": "business-rejected", "code": "IDEMPOTENCY_IN_PROGRESS",
                      "message": "A submission with this idempotency key is already in progress."}
            do_audit(result, operation_ref, ["IDEMPOTENCY_IN_PROGRESS"])
            return result
        if claim["kind"] == "expired":
            result = {"status": "business-rejected", "code": "IDEMPOTENCY_RECOVERY_REQUIRED",
                      "message": "A previous claim expired before completion. Reconcile the operation outcome (transaction/outbox) before retrying; automatic re-execution is unsafe."}
            do_audit(result, operation_ref, ["IDEMPOTENCY_RECOVERY_REQUIRED"])
            return result

        try:
            data = handler(payload, {
                "auth": auth, "idempotencyKey": request["idempotencyKey"],
                "correlationId": request.get("correlationId", ""), "formId": ir["formId"],
            })
            if isinstance(data, dict):
                data = filter_readable_values(ir, data, read_policy["denied"])
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
            self.idempotency.complete(scope_key, result)
        else:
            self.idempotency.release(scope_key)
        do_audit(result, operation_ref, [i["code"] for i in result.get("issues", [])])
        return result


def auth_context_from_claims(claims: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "userId": claims.get("sub"), "tenantId": claims.get("tenant_id"),
        "roles": claims.get("roles", []), "permissions": claims.get("permissions", []),
        "sessionId": claims.get("sid"),
    }
