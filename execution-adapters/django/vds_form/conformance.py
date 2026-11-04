"""Load and run the SHARED cross-language conformance fixtures.

The fixtures live in packages/form-conformance/fixtures and are the single
source of truth. This runner executes the expression suite against the Python
engine and reports per-case pass/fail, exactly like the TypeScript runner.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

from .expressions import evaluate, deep_equal

_DEFAULT_FIXTURES = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "form-conformance", "fixtures")
)


def fixtures_dir() -> str:
    return os.environ.get("VDS_CONFORMANCE_FIXTURES", _DEFAULT_FIXTURES)


def run_expression_conformance(path: Optional[str] = None) -> List[Dict[str, Any]]:
    path = path or os.path.join(fixtures_dir(), "expressions.json")
    with open(path, "r", encoding="utf-8") as fh:
        suite = json.load(fh)
    results: List[Dict[str, Any]] = []
    for case in suite["cases"]:
        actual = evaluate(case["expr"], case.get("scope", {}))
        expect = case["expect"]
        if expect["ok"]:
            passed = actual.get("ok") is True and deep_equal(actual.get("value"), expect["value"])
        else:
            passed = actual.get("ok") is False and actual.get("code") == expect["code"]
        results.append({
            "suite": "vds.expr/1", "id": case["id"], "passed": passed,
            "expected": expect, "actual": actual,
        })
    return results


def summary(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    passed = sum(1 for r in results if r["passed"])
    return {"total": len(results), "passed": passed, "failed": len(results) - passed}
