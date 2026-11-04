"""
Server-side effective-state computation + validation — Python port of
packages/form-validation. Operates on the deterministic FormIR (the shared
cross-language contract produced by the TS compiler / `vds-form compile --json`).
The same rules run on the server so client-side hiding is never authorization.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List

from .expressions import evaluate_boolean, get_path

FORMAT_PATTERNS = {
    "email": re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$"),
    "url": re.compile(r"^https?://[^\s/$.?#].[^\s]*$", re.IGNORECASE),
    "phone": re.compile(r"^\+?[0-9\s\-().]{6,20}$"),
    "date": re.compile(r"^\d{4}-\d{2}-\d{2}$"),
    "time": re.compile(r"^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$"),
    "date-time": re.compile(r"^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$"),
    "uuid": re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE),
    "postal-code": re.compile(r"^[A-Za-z0-9][A-Za-z0-9\s-]{2,11}$"),
    "color": re.compile(r"#([0-9a-f]{3}|[0-9a-f]{6})$", re.IGNORECASE),
    "barcode": re.compile(r"^[A-Za-z0-9-]{4,64}$"),
}


def is_empty_value(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return len(v) == 0
    if isinstance(v, list):
        return len(v) == 0
    if isinstance(v, dict):
        return len(v) == 0
    return False


def is_safe_pattern(pattern: str) -> bool:
    if len(pattern) > 1000:
        return False
    if re.search(r"(\+|\*|\{)\s*(\)|\])?\s*(\+|\*|\{[0-9,]+\})", pattern):
        return False
    try:
        re.compile(pattern)
        return True
    except re.error:
        return False


def type_matches(value: Any, value_type: str) -> bool:
    if value_type == "string":
        return isinstance(value, str)
    if value_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if value_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if value_type == "boolean":
        return isinstance(value, bool)
    if value_type == "string[]":
        return isinstance(value, list) and all(isinstance(v, str) for v in value)
    if value_type == "number[]":
        return isinstance(value, list) and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value)
    if value_type in ("object", "asset"):
        return isinstance(value, dict)
    if value_type == "object[]":
        return isinstance(value, list) and all(isinstance(v, dict) for v in value)
    if value_type == "asset[]":
        return isinstance(value, list)
    if value_type == "null":
        return value is None
    return True


def compute_effective_state(ir: Dict[str, Any], values: Dict[str, Any],
                            context: Dict[str, Any] | None = None,
                            sources: Dict[str, Any] | None = None):
    state = {"visibility": {}, "required": {}, "disabled": {}, "readonly": {}}
    for f in ir["fields"]:
        state["visibility"][f["id"]] = not f.get("hidden", False)
        state["required"][f["id"]] = f.get("required", False)
        state["disabled"][f["id"]] = f.get("disabled", False)
        state["readonly"][f["id"]] = f.get("readonly", False)
    errors = []
    for c in ir.get("conditions", []):
        r = evaluate_boolean(c["when"], {"values": values, "context": context or {}, "sources": sources or {}})
        if not r["ok"]:
            errors.append({"id": c["id"], "message": r["message"]})
            continue
        if r["value"] is True:
            for eff in c.get("effects", []):
                s = eff.get("set", {})
                fid = eff["fieldId"]
                for key in ("visible", "required", "disabled", "readonly"):
                    if key in s:
                        target = "visibility" if key == "visible" else key
                        state[target][fid] = s[key]
    return state, errors


def expand_field_instances(ir: Dict[str, Any], values: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    repeaters = {f["id"]: f for f in ir["fields"] if f["type"] == "repeater"}
    for f in ir["fields"]:
        if f["type"] in ("repeater", "group"):
            out.append({"field": f, "concreteKey": f["key"]})
        if not f.get("repeaterId"):
            if f["type"] not in ("repeater", "group"):
                out.append({"field": f, "concreteKey": f["key"]})
            continue
        repeater = repeaters.get(f["repeaterId"])
        if not repeater:
            continue
        rows = get_path(values, repeater["key"])
        count = len(rows) if isinstance(rows, list) else 0
        for i in range(count):
            concrete = f["key"].replace(f"{repeater['key']}[]", f"{repeater['key']}.{i}")
            out.append({"field": f, "concreteKey": concrete,
                        "rowScope": {"rowPrefix": f"{repeater['key']}.{i}", "rowIndex": i, "parentPrefix": ""}})
    return out


def _issue(code: str, message: str, path: str, field_id: str | None,
           source: str = "field", severity: str = "error") -> Dict[str, Any]:
    return {"code": code, "message": message, "path": path, "fieldId": field_id, "source": source, "severity": severity}


def _validate_one(inst: Dict[str, Any], values: Dict[str, Any], state: Dict[str, Any], phase: str) -> List[Dict[str, Any]]:
    field = inst["field"]
    concrete = inst["concreteKey"]
    issues: List[Dict[str, Any]] = []
    if state["visibility"].get(field["id"]) is False:
        return issues
    ftype = field["type"]
    v = field.get("validation", {})

    if ftype in ("group", "repeater"):
        if ftype == "repeater":
            rows = get_path(values, field["key"])
            count = len(rows) if isinstance(rows, list) else 0
            if state["required"].get(field["id"]) and count == 0:
                issues.append(_issue("REQUIRED", "At least one entry is required.", concrete, field["id"]))
            if isinstance(v.get("minItems"), (int, float)) and count < v["minItems"]:
                issues.append(_issue("MIN_ITEMS", f"At least {v['minItems']} entries required.", concrete, field["id"]))
            if isinstance(v.get("maxItems"), (int, float)) and count > v["maxItems"]:
                issues.append(_issue("MAX_ITEMS", f"At most {v['maxItems']} entries allowed.", concrete, field["id"]))
        return issues

    value = get_path(values, concrete)
    required = state["required"].get(field["id"], field.get("required", False))
    disabled = state["disabled"].get(field["id"], field.get("disabled", False))

    if required and not disabled:
        if ftype == "consent":
            if value is not True:
                issues.append(_issue("REQUIRED", "This consent is required.", concrete, field["id"]))
        elif is_empty_value(value):
            issues.append(_issue("REQUIRED", "This field is required.", concrete, field["id"]))
    if is_empty_value(value):
        return issues

    if not type_matches(value, field.get("valueType", "string")):
        issues.append(_issue("TYPE_INVALID", f"Expected {field.get('valueType')}.", concrete, field["id"]))
        return issues

    if isinstance(value, str):
        if v.get("minLength") is not None and len(value) < v["minLength"]:
            issues.append(_issue("MIN_LENGTH", f"Must be at least {v['minLength']} characters.", concrete, field["id"]))
        if v.get("maxLength") is not None and len(value) > v["maxLength"]:
            issues.append(_issue("MAX_LENGTH", f"Must be at most {v['maxLength']} characters.", concrete, field["id"]))
        fmt = v.get("format")
        if fmt:
            pat = FORMAT_PATTERNS.get(fmt)
            if pat and not pat.match(value):
                issues.append(_issue("FORMAT_INVALID", f"Invalid {fmt} format.", concrete, field["id"]))
            if fmt == "date" and pat and pat.match(value):
                y, m, d = (int(x) for x in value.split("-"))
                try:
                    dt = datetime(y, m, d)
                    if (dt.year, dt.month, dt.day) != (y, m, d):
                        issues.append(_issue("FORMAT_INVALID", "Invalid calendar date.", concrete, field["id"]))
                except ValueError:
                    issues.append(_issue("FORMAT_INVALID", "Invalid calendar date.", concrete, field["id"]))
        if v.get("pattern"):
            if not is_safe_pattern(v["pattern"]):
                issues.append(_issue("PATTERN_UNSAFE", "Validation pattern rejected as unsafe.", concrete, field["id"]))
            elif len(value) <= 10000 and not re.search(v["pattern"], value):
                issues.append(_issue("PATTERN_MISMATCH", "Value does not match the required pattern.", concrete, field["id"]))

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if v.get("min") is not None and value < v["min"]:
            issues.append(_issue("MIN_VALUE", f"Must be >= {v['min']}.", concrete, field["id"]))
        if v.get("max") is not None and value > v["max"]:
            issues.append(_issue("MAX_VALUE", f"Must be <= {v['max']}.", concrete, field["id"]))
        if v.get("precision") is not None:
            scaled = value * (10 ** v["precision"])
            if abs(scaled - round(scaled)) > 1e-9:
                issues.append(_issue("PRECISION_EXCEEDED", f"At most {v['precision']} decimal places allowed.", concrete, field["id"]))

    if isinstance(value, list):
        if v.get("minItems") is not None and len(value) < v["minItems"]:
            issues.append(_issue("MIN_ITEMS", f"Select at least {v['minItems']}.", concrete, field["id"]))
        if v.get("maxItems") is not None and len(value) > v["maxItems"]:
            issues.append(_issue("MAX_ITEMS", f"Select at most {v['maxItems']}.", concrete, field["id"]))

    if field.get("valueType") in ("asset", "asset[]"):
        assets = value if isinstance(value, list) else [value]
        if not v.get("multiple") and isinstance(value, list) and len(value) > 1:
            issues.append(_issue("MULTIPLE_NOT_ALLOWED", "Only one file is allowed.", concrete, field["id"]))
        for a in assets:
            if not isinstance(a, dict):
                continue
            mime = a.get("mimeType")
            if v.get("accept") and mime:
                ok = any(acc == mime or (acc.endswith("/*") and mime.startswith(acc[:-1])) or (acc.startswith(".") and acc[1:] in mime) for acc in v["accept"])
                if not ok:
                    issues.append(_issue("ASSET_TYPE_REJECTED", f"File type {mime} is not allowed.", concrete, field["id"]))
            if v.get("maxSizeBytes") is not None and isinstance(a.get("sizeBytes"), (int, float)) and a["sizeBytes"] > v["maxSizeBytes"]:
                issues.append(_issue("ASSET_TOO_LARGE", f"File exceeds {v['maxSizeBytes']} bytes.", concrete, field["id"]))
            if phase == "submit" and not a.get("assetRef"):
                issues.append(_issue("ASSET_NOT_UPLOADED", "File must be uploaded before submitting.", concrete, field["id"]))
    return issues


def validate_values(ir: Dict[str, Any], values: Dict[str, Any], state: Dict[str, Any],
                    phase: str = "submit", context: Dict[str, Any] | None = None,
                    sources: Dict[str, Any] | None = None) -> Dict[str, Any]:
    issues: List[Dict[str, Any]] = []
    for inst in expand_field_instances(ir, values):
        issues.extend(_validate_one(inst, values, state, phase))
    for rule in ir.get("crossFieldRules", []):
        r = evaluate_boolean(rule["expr"], {"values": values, "context": context or {}, "sources": sources or {}})
        if not r["ok"]:
            issues.append(_issue("RULE_EVALUATION_FAILED", r["message"], rule.get("path", ""), None))
        elif r["value"] is False:
            msg = rule.get("message", "Cross-field rule failed.")
            if isinstance(msg, dict):
                msg = msg.get("en") or next(iter(msg.values()), "Cross-field rule failed.")
            issues.append(_issue("CROSS_FIELD", msg, rule.get("path", ""), None, severity=rule.get("severity", "error")))
    valid = not any(i["severity"] == "error" for i in issues)
    return {"valid": valid, "issues": issues}
