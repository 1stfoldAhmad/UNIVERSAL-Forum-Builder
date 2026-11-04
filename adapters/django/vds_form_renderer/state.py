"""Server-side render state: defaults, repeater rows, formulas, effective state.

Framework-free. Operates on the compiled FormIR (shared cross-language
contract) and reuses the conformance-verified vds_form expression engine so SSR
output matches the headless runtime.
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List

from vds_form.expressions import evaluate, get_path
from vds_form.submission import set_in
from vds_form.validation import compute_effective_state


def _repeater_key(target: str) -> str | None:
    if "[]" not in target:
        return None
    return target.split("[]", 1)[0].rstrip(".")


def prepare_render_state(ir: Dict[str, Any], initial_values: Dict[str, Any] | None = None) -> Dict[str, Any]:
    values: Dict[str, Any] = copy.deepcopy(initial_values or {})

    # Defaults for non-nested fields whose path is absent.
    for f in ir["fields"]:
        if f.get("parentId") or f.get("repeaterId"):
            continue
        if "defaultValue" in f and get_path(values, f["key"]) is None:
            values = set_in(values, f["key"], copy.deepcopy(f["defaultValue"]))

    # Repeater rows: honour minItems by padding empty rows.
    repeater_rows: Dict[str, List[int]] = {}
    for f in ir["fields"]:
        if f["type"] != "repeater":
            continue
        rows = get_path(values, f["key"])
        rows = list(rows) if isinstance(rows, list) else []
        min_items = int(f.get("validation", {}).get("minItems", f.get("minItems", 0)) or 0)
        while len(rows) < min_items:
            rows.append({})
        values = set_in(values, f["key"], rows)
        repeater_rows[f["id"]] = list(range(len(rows)))

    # Formulas: iterate to a fixed point (dependency order is not guaranteed).
    formulas = ir.get("formulas", [])
    for _ in range(len(formulas) + 1):
        changed = False
        for formula in formulas:
            target = formula["target"]
            rep_key = _repeater_key(target)
            if rep_key is not None:
                rows = get_path(values, rep_key) or []
                for i in range(len(rows) if isinstance(rows, list) else 0):
                    concrete = target.replace("[]", f".{i}", 1)
                    scope = {"values": values, "rowPrefix": f"{rep_key}.{i}", "rowIndex": i, "context": {}, "sources": {}}
                    r = evaluate(formula["expr"], scope)
                    if r["ok"] and get_path(values, concrete) != r["value"]:
                        values = set_in(values, concrete, r["value"])
                        changed = True
            else:
                r = evaluate(formula["expr"], {"values": values, "context": {}, "sources": {}})
                if r["ok"] and get_path(values, target) != r["value"]:
                    values = set_in(values, target, r["value"])
                    changed = True
        if not changed:
            break

    state, _errors = compute_effective_state(ir, values)
    return {"values": values, "state": state, "repeater_rows": repeater_rows}
