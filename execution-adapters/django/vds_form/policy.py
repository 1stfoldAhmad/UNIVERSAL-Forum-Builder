"""Shared submission/read security policy — Python port of
packages/form-validation/src/policy.ts. Mirrors the shared security fixtures.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

FORBIDDEN_SEGMENTS = {"__proto__", "prototype", "constructor"}
MAX_DEPTH = 64
MAX_NODES = 10000
ASSET_KEYS = {"id", "name", "mimeType", "sizeBytes", "source", "localUri", "assetRef", "url"}
_REMOVED = object()


def _issue(code: str, message: str, path: str, field_id: Optional[str] = None) -> Dict[str, Any]:
    out = {"code": code, "message": message, "path": path, "severity": "error", "source": "schema"}
    if field_id is not None:
        out["fieldId"] = field_id
    return out


def path_segments(path: str) -> Optional[List[str]]:
    if not isinstance(path, str) or not path or len(path) > 512:
        return None
    expanded = re.sub(r"\[(\d*)\]", lambda m: "." + ("[]" if m.group(1) == "" else m.group(1)), path)
    out: List[str] = []
    for part in expanded.split("."):
        if part == "" or part in FORBIDDEN_SEGMENTS:
            return None
        out.append("[]" if re.fullmatch(r"\d+", part) else part)
    return out


def normalize_path(path: str) -> Optional[str]:
    seg = path_segments(path)
    if seg is None:
        return None
    out = ""
    for part in seg:
        if part == "[]":
            out += "[]"
        else:
            out += ("." if out else "") + part
    return out


def is_path_under(path: str, ancestor: str) -> bool:
    p = path_segments(path)
    a = path_segments(ancestor)
    if p is None or a is None or len(p) < len(a):
        return False
    return all(p[i] == a[i] for i in range(len(a)))


def strip_paths(values: Any, templates: List[str]) -> Any:
    normalized = [n for n in (normalize_path(t) for t in templates) if n]

    def walk(value: Any, segments: List[str], depth: int) -> Any:
        if depth > MAX_DEPTH:
            return _REMOVED
        norm = ".".join(segments)
        if any(is_path_under(norm, t) for t in normalized):
            return _REMOVED
        if isinstance(value, list):
            out = []
            for i, item in enumerate(value):
                cleaned = walk(item, segments + [str(i)], depth + 1)
                if cleaned is not _REMOVED:
                    out.append(cleaned)
            return out
        if isinstance(value, dict):
            out: Dict[str, Any] = {}
            for k, v in value.items():
                if k in FORBIDDEN_SEGMENTS:
                    continue
                cleaned = walk(v, segments + [str(k)], depth + 1)
                if cleaned is not _REMOVED:
                    out[k] = cleaned
            return out
        return value

    return walk(values, [], 0)


def hidden_template_paths(ir: Dict[str, Any], visibility: Dict[str, Any], include_hidden: bool = False) -> List[str]:
    if include_hidden:
        return []
    return [f["key"] for f in ir["fields"] if visibility.get(f["id"]) is False]


def _templates(ir: Dict[str, Any]) -> Set[str]:
    out = set()
    for f in ir["fields"]:
        n = normalize_path(f["key"])
        if n:
            out.add(n)
    return out


def _nearest_field(ir: Dict[str, Any], norm_path: str) -> Optional[Dict[str, Any]]:
    best = None
    best_len = -1
    for f in ir["fields"]:
        n = normalize_path(f["key"])
        if n and is_path_under(norm_path, n):
            ln = len(path_segments(n) or [])
            if ln > best_len:
                best, best_len = f, ln
    return best


def _allowed_by_fields(ir: Dict[str, Any], templates: Set[str], norm_path: str) -> bool:
    if norm_path in templates:
        return True
    if any(is_path_under(t, norm_path) for t in templates):
        return True
    field = _nearest_field(ir, norm_path)
    if not field:
        return False
    field_norm = normalize_path(field["key"])
    path_seg = path_segments(norm_path)
    field_seg = path_segments(field_norm)
    if path_seg is None or field_seg is None:
        return False
    rest = path_seg[len(field_seg):]
    if not rest:
        return True
    vt = field.get("valueType", "string")
    if vt in ("asset", "asset[]"):
        props = [s for s in rest if s != "[]"]
        return len(props) == 1 and props[0] in ASSET_KEYS and len(rest) <= (2 if vt == "asset[]" else 1)
    if vt in ("string[]", "number[]"):
        return all(s == "[]" for s in rest)
    return False


def collect_unknown_property_issues(ir: Dict[str, Any], values: Dict[str, Any],
                                    operation_inputs: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    templates = _templates(ir)
    op_roots = set((operation_inputs or {}).keys())
    nodes = 0

    def walk(value: Any, segments: List[str], depth: int) -> None:
        nonlocal nodes
        if depth > MAX_DEPTH:
            issues.append(_issue("PAYLOAD_TOO_DEEP", "Payload nesting exceeds the security budget.", ".".join(segments)))
            return
        nodes += 1
        if nodes > MAX_NODES:
            issues.append(_issue("PAYLOAD_TOO_LARGE", "Payload exceeds the security node budget.", ".".join(segments)))
            return
        if isinstance(value, list):
            for i, v in enumerate(value):
                walk(v, segments + [str(i)], depth + 1)
            return
        if not isinstance(value, dict):
            return
        for k, v in value.items():
            child = segments + [str(k)]
            concrete = ".".join(child)
            if k in FORBIDDEN_SEGMENTS:
                issues.append(_issue("UNSAFE_PROPERTY", "Prototype-pollution property rejected.", concrete))
                continue
            norm = normalize_path(concrete)
            if norm is None:
                issues.append(_issue("UNKNOWN_PROPERTY", "Property path is not declared.", concrete))
                continue
            if len(segments) == 0 and k in op_roots:
                continue
            if not _allowed_by_fields(ir, templates, norm):
                issues.append(_issue("UNKNOWN_PROPERTY", "Property is not a declared form field.", concrete))
            walk(v, child, depth + 1)

    walk(values, [], 0)
    return issues


def _type_matches(value: Any, vt: str) -> bool:
    if vt == "string":
        return isinstance(value, str)
    if vt == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if vt == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if vt == "boolean":
        return isinstance(value, bool)
    if vt == "string[]":
        return isinstance(value, list) and all(isinstance(v, str) for v in value)
    if vt == "number[]":
        return isinstance(value, list) and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value)
    if vt in ("object", "asset"):
        return isinstance(value, dict)
    if vt == "object[]":
        return isinstance(value, list) and all(isinstance(v, dict) for v in value)
    if vt == "asset[]":
        return isinstance(value, list)
    if vt == "null":
        return value is None
    return False


def validate_operation_inputs(defs: Optional[Dict[str, Any]], values: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    out: Dict[str, Any] = {}
    issues: List[Dict[str, Any]] = []
    if not defs:
        return out, issues

    def check(d: Dict[str, Any], value: Any, path: str) -> Any:
        if value is None:
            if d.get("required"):
                issues.append(_issue("OPERATION_INPUT_REQUIRED", "Required operation input is missing.", path))
            return None
        if not _type_matches(value, d.get("valueType", "string")):
            issues.append(_issue("OPERATION_INPUT_TYPE_INVALID", f"Expected {d.get('valueType')}.", path))
            return None
        if isinstance(value, list):
            if not d.get("items"):
                return value
            cleaned = [check(d["items"], item, f"{path}.{i}") for i, item in enumerate(value)]
            return [v for v in cleaned if v is not None]
        if isinstance(value, dict):
            obj: Dict[str, Any] = {}
            for k, v in value.items():
                if k in FORBIDDEN_SEGMENTS:
                    issues.append(_issue("UNSAFE_PROPERTY", "Prototype-pollution property rejected.", f"{path}.{k}"))
                    continue
                child = (d.get("properties") or {}).get(k)
                if child is None:
                    if not d.get("additionalProperties"):
                        issues.append(_issue("UNKNOWN_PROPERTY", "Operation input property is not declared.", f"{path}.{k}"))
                    else:
                        obj[k] = v
                    continue
                cleaned = check(child, v, f"{path}.{k}")
                if cleaned is not None:
                    obj[k] = cleaned
            return obj
        return value

    for name, d in defs.items():
        if name in FORBIDDEN_SEGMENTS:
            issues.append(_issue("UNSAFE_PROPERTY", "Operation input name rejected.", name))
            continue
        cleaned = check(d, values.get(name), name)
        if cleaned is not None:
            out[name] = cleaned
    return out, issues


def compute_read_policy(ir: Dict[str, Any], auth: Optional[Dict[str, Any]], rbac: Any) -> Dict[str, Any]:
    denied: Set[str] = set()
    unresolved: List[str] = []
    issues: List[Dict[str, Any]] = []
    for field_id, access in ((ir.get("security") or {}).get("fieldAccess") or {}).items():
        perms = access.get("read") or []
        if not perms:
            continue
        field = next((f for f in ir["fields"] if f["id"] == field_id), None)
        path = field["key"] if field else field_id
        if rbac is None or auth is None:
            denied.add(field_id)
            unresolved.append(field_id)
            issues.append(_issue("FIELD_READ_UNRESOLVED", "Read authorization cannot be resolved; field is hidden.", path, field_id))
            continue
        try:
            decision = rbac.evaluate(auth, perms)
            if not decision.get("allowed"):
                denied.add(field_id)
                missing = decision.get("missing") or []
                msg = f"Missing read permissions: {', '.join(missing)}" if missing else "Read permission denied."
                issues.append(_issue("FIELD_READ_DENIED", msg, path, field_id))
        except Exception as e:  # noqa: BLE001
            denied.add(field_id)
            unresolved.append(field_id)
            issues.append(_issue("FIELD_READ_UNRESOLVED", f"Read evaluator failed: {e}", path, field_id))
    return {"denied": denied, "unresolved": unresolved, "issues": issues}


def filter_readable_values(ir: Dict[str, Any], values: Any, denied: Set[str]) -> Any:
    if not denied or not isinstance(values, dict):
        return values
    templates = [f["key"] for f in ir["fields"] if f["id"] in denied]
    cleaned = strip_paths(values, templates)
    return cleaned if isinstance(cleaned, dict) else {}


def _set_in(root: Dict[str, Any], path: str, value: Any) -> Dict[str, Any]:
    parts = re.sub(r"\[(\d*)\]", lambda m: "." + ("[]" if m.group(1) == "" else m.group(1)), path).split(".")
    parts = [p for p in parts if p]
    cursor: Dict[str, Any] = root
    for p in parts[:-1]:
        if p in FORBIDDEN_SEGMENTS:
            return root
        if not isinstance(cursor.get(p), dict):
            cursor[p] = {}
        cursor = cursor[p]
    if parts and parts[-1] not in FORBIDDEN_SEGMENTS:
        cursor[parts[-1]] = value
    return root


def prepare_submission_values(ir: Dict[str, Any], request_values: Any, visibility: Dict[str, Any]) -> Dict[str, Any]:
    submission = ir.get("submission") or {}
    issues: List[Dict[str, Any]] = []
    if not isinstance(request_values, dict):
        return {"fieldValues": {}, "operationInputs": {}, "issues": [_issue("PAYLOAD_INVALID", "Submission values must be an object.", "")]}
    op_defs = submission.get("operationInputs")
    op_roots = set((op_defs or {}).keys())
    mapping = submission.get("inputMapping")
    if mapping:
        allowed_roots = set(mapping.keys())
    else:
        allowed_roots = set()
        for f in ir["fields"]:
            if not f.get("parentId"):
                allowed_roots.add(f["key"].split(".")[0].replace("[]", ""))
    field_values: Dict[str, Any] = {}
    op_raw: Dict[str, Any] = {}
    for k, v in request_values.items():
        if k in FORBIDDEN_SEGMENTS:
            issues.append(_issue("UNSAFE_PROPERTY", "Prototype-pollution property rejected.", k))
            continue
        if k in op_roots:
            op_raw[k] = v
            continue
        if k not in allowed_roots:
            issues.append(_issue("UNKNOWN_PROPERTY", "Submission property is not declared.", k))
            continue
        if mapping:
            source_path = mapping[k]
            if normalize_path(source_path) is None:
                issues.append(_issue("INPUT_MAPPING_INVALID", "Input mapping source path is invalid.", k))
                continue
            _set_in(field_values, source_path, v)
        else:
            field_values[k] = v
    hidden = hidden_template_paths(ir, visibility, submission.get("includeHidden", False))
    cleaned = strip_paths(field_values, hidden)
    field_values = cleaned if isinstance(cleaned, dict) else {}
    issues.extend(collect_unknown_property_issues(ir, field_values, op_defs))
    op_values, op_issues = validate_operation_inputs(op_defs, op_raw)
    issues.extend(op_issues)
    return {"fieldValues": field_values, "operationInputs": op_values, "issues": issues}
