"""Submission payload builder — Python port of packages/form-submission's
buildSubmissionPayload. Strips hidden fields, applies inputMapping, and rejects
un-uploaded local assets. Operates on the shared FormIR."""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from .expressions import get_path


def build_payload(ir: Dict[str, Any], values: Dict[str, Any], state: Dict[str, Any],
                  submission: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    issues: List[Dict[str, Any]] = []
    include_hidden = submission.get("includeHidden", False)
    hidden_keys = [f["key"] for f in ir["fields"] if not include_hidden and state["visibility"].get(f["id"]) is False]

    def is_under_hidden(key: str) -> bool:
        return any(key == h or key.startswith(f"{h}.") or key.startswith(f"{h}[") for h in hidden_keys)

    visible_values = {k: v for k, v in values.items() if not is_under_hidden(k)}

    def strip_hidden(obj: Dict[str, Any], prefix: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else k
            if is_under_hidden(path):
                continue
            out[k] = strip_hidden(v, path) if isinstance(v, dict) else v
        return out

    cleaned = strip_hidden(visible_values, "")

    mapping = submission.get("inputMapping")
    if mapping:
        payload: Dict[str, Any] = {}
        for param, source_path in mapping.items():
            if is_under_hidden(source_path):
                continue
            v = get_path(cleaned, source_path)
            if v is None:
                issues.append({"code": "MAPPING_SOURCE_MISSING", "message": f'Mapping source "{source_path}" has no value.', "path": source_path, "severity": "warning", "source": "schema"})
                continue
            payload[param] = v
    else:
        payload = cleaned

    def check_assets(v: Any, path: str) -> None:
        if isinstance(v, list):
            for i, x in enumerate(v):
                check_assets(x, f"{path}.{i}")
            return
        if isinstance(v, dict):
            if "localUri" in v and "assetRef" not in v:
                issues.append({"code": "ASSET_NOT_UPLOADED", "message": "Asset must be uploaded before submission.", "path": path, "severity": "error", "source": "field"})

    for f in ir["fields"]:
        if f.get("valueType") in ("asset", "asset[]"):
            v = get_path(payload, f["key"])
            if v is None:
                v = get_path(cleaned, f["key"])
            check_assets(v, f["key"])
    return payload, issues
