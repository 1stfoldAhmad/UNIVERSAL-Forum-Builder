"""Cross-language compiler/validation/payload conformance for the Python adapter.

The expected results come from the SHARED fixtures (forms.json); the inputs are
the deterministic FormIR compiled by the TS compiler (fixtures/ir/*.ir.json).
This proves the Python server reproduces the TS validation + payload semantics.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vds_form.validation import compute_effective_state, validate_values
from vds_form.payload import build_payload
from vds_form.expressions import deep_equal

HERE = os.path.dirname(__file__)
IR_DIR = os.path.join(HERE, "fixtures", "ir")
FORMS_JSON = os.path.normpath(os.path.join(HERE, "..", "..", "..", "packages", "form-conformance", "fixtures", "forms.json"))


def _load_forms():
    with open(FORMS_JSON, encoding="utf-8") as fh:
        return json.load(fh)


def _load_ir(name):
    with open(os.path.join(IR_DIR, name), encoding="utf-8") as fh:
        return json.load(fh)


def test_validation_fixtures_match():
    forms = _load_forms()
    for case in forms["validation"]:
        ir = _load_ir(f"validation-{case['id']}.ir.json")
        state, _ = compute_effective_state(ir, case["values"])
        result = validate_values(ir, case["values"], state, phase=case["phase"])
        actual = [{"code": i["code"], "path": i["path"]} for i in result["issues"]]
        expected = case["expectIssues"]
        if not expected:
            assert not [i for i in result["issues"] if i["severity"] == "error"], f"{case['id']}: expected no errors, got {actual}"
        else:
            for e in expected:
                assert any(a["code"] == e["code"] and a["path"] == e["path"] for a in actual), f"{case['id']}: missing {e}, got {actual}"


def test_payload_fixtures_match():
    forms = _load_forms()
    for case in forms["payload"]:
        ir = _load_ir(f"payload-{case['id']}.ir.json")
        state, _ = compute_effective_state(ir, case["values"])
        payload, _ = build_payload(ir, case["values"], state, ir["submission"])
        assert deep_equal(payload, case["expectPayload"]), f"{case['id']}: expected {case['expectPayload']}, got {payload}"
