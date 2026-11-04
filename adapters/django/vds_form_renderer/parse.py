"""Parse no-JS form POST bodies (dot-path names) into typed FormValues."""
from __future__ import annotations

import re
from typing import Any, Dict, List

from vds_form.submission import set_in
from vds_form.validation import expand_field_instances


def _skeleton(ir: Dict[str, Any], data: Dict[str, List[str]]) -> Dict[str, Any]:
    skeleton: Dict[str, Any] = {}
    for f in ir["fields"]:
        if f["type"] != "repeater":
            continue
        max_idx = -1
        for name in data:
            if name.startswith(f["key"] + "."):
                head = name[len(f["key"]) + 1:].split(".")[0]
                if head.isdigit():
                    max_idx = max(max_idx, int(head))
        if max_idx >= 0:
            skeleton = set_in(skeleton, f["key"], [{} for _ in range(max_idx + 1)])
    return skeleton


def _coerce(field: Dict[str, Any] | None, value: Any) -> Any:
    vt = (field or {}).get("valueType")
    ft = (field or {}).get("type")
    if isinstance(value, list):
        if vt == "number[]":
            return [None if x == "" else float(x) for x in value]
        return value
    if ft in ("checkbox", "switch", "consent"):
        return value in ("true", "on", "1")
    if value == "":
        return None
    if vt == "integer":
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    if vt == "number":
        try:
            return float(value)
        except (TypeError, ValueError):
            return value
    if vt == "boolean":
        return value in ("true", "on", "1")
    return value


def parse_form_values(ir: Dict[str, Any], data: Dict[str, List[str]], csrf_param: str = "csrfmiddlewaretoken") -> Dict[str, Any]:
    """``data`` maps field name → list of raw string values (QueryDict.lists())."""
    skeleton = _skeleton(ir, data)
    instances = expand_field_instances(ir, skeleton)
    by_path = {i["concreteKey"]: i["field"] for i in instances}
    values: Dict[str, Any] = {}
    for name, raw in data.items():
        if name == csrf_param or name.startswith("_"):
            continue
        field = by_path.get(name)
        value = raw if (field and field.get("valueType") in ("string[]", "number[]")) or (field and field["type"] == "multiselect") else (raw[-1] if raw else "")
        values = set_in(values, name, _coerce(field, value))
    for inst in instances:
        f = inst["field"]
        if f["type"] in ("checkbox", "switch", "consent") and inst["concreteKey"] not in data:
            values = set_in(values, inst["concreteKey"], False)
    return values
