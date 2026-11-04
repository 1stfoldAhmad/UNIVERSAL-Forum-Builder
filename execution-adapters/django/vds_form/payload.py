"""Submission payload builder — Python port of packages/form-submission.
Hidden values are stripped recursively (including repeater rows); undeclared
properties are rejected; typed operation inputs are validated separately.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from .expressions import get_path
from .policy import (
    collect_unknown_property_issues, hidden_template_paths, is_path_under,
    strip_paths, validate_operation_inputs,
)
from .validation import expand_field_instances


def build_payload(ir: Dict[str, Any], values: Dict[str, Any], state: Dict[str, Any],
                  submission: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    issues: List[Dict[str, Any]] = []
    hidden = hidden_template_paths(ir, state.get("visibility", {}), submission.get("includeHidden", False))
    stripped = strip_paths(values, hidden)
    stripped = stripped if isinstance(stripped, dict) else {}
    op_defs = submission.get("operationInputs")
    op_roots = set((op_defs or {}).keys())
    op_raw: Dict[str, Any] = {}
    field_values: Dict[str, Any] = {}
    for k, v in stripped.items():
        if k in op_roots:
            op_raw[k] = v
        else:
            field_values[k] = v
    issues.extend(collect_unknown_property_issues(ir, field_values))
    op_values, op_issues = validate_operation_inputs(op_defs, op_raw)
    issues.extend(op_issues)
    if any(i["severity"] == "error" for i in issues):
        return {}, issues

    mapping = submission.get("inputMapping")
    if mapping:
        payload: Dict[str, Any] = {}
        for param, source_path in mapping.items():
            if not submission.get("includeHidden", False) and any(is_path_under(source_path, h) for h in hidden):
                continue
            v = get_path(field_values, source_path)
            if v is None:
                issues.append({"code": "MAPPING_SOURCE_MISSING", "message": f'Mapping source "{source_path}" has no value.', "path": source_path, "severity": "warning", "source": "schema"})
                continue
            payload[param] = v
    else:
        payload = dict(field_values)
    payload.update(op_values)

    def check_assets(v: Any, path: str, field_id: str) -> None:
        if isinstance(v, list):
            for i, x in enumerate(v):
                check_assets(x, f"{path}.{i}", field_id)
            return
        if isinstance(v, dict) and "localUri" in v and "assetRef" not in v:
            issues.append({"code": "ASSET_NOT_UPLOADED", "message": "Asset must be uploaded before submission.", "path": path, "fieldId": field_id, "severity": "error", "source": "field"})

    for inst in expand_field_instances(ir, field_values):
        f = inst["field"]
        if f.get("valueType") in ("asset", "asset[]"):
            check_assets(get_path(field_values, inst["concreteKey"]), inst["concreteKey"], f["id"])
    return payload, issues
