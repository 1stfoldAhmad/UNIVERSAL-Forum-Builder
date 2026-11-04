"""Cross-language conformance: the Python engine must satisfy the SAME shared
fixtures as the TypeScript reference (packages/form-conformance/fixtures)."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vds_form.conformance import run_expression_conformance, summary


def test_every_expression_fixture_passes():
    results = run_expression_conformance()
    failures = [r for r in results if not r["passed"]]
    assert not failures, "Conformance failures:\n" + "\n".join(
        f"  {r['id']}: expected {r['expected']}, actual {r['actual']}" for r in failures
    )
    assert len(results) >= 50


def test_summary_is_green():
    s = summary(run_expression_conformance())
    assert s["failed"] == 0
    assert s["passed"] == s["total"]
