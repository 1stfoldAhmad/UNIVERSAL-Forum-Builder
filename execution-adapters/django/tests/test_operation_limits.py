"""Shared cross-language operation-input resource-limit vectors."""
import json
from pathlib import Path

from vds_form.policy import validate_operation_inputs

FIXTURE = Path(__file__).resolve().parents[3] / "packages" / "form-conformance" / "fixtures" / "operation-limits.json"


def test_operation_limit_vectors():
    data = json.loads(FIXTURE.read_text())
    for c in data["cases"]:
        _values, issues = validate_operation_inputs(c["defs"], c["values"])
        codes = [i["code"] for i in issues]
        if c["expectCodes"]:
            for code in c["expectCodes"]:
                assert code in codes, c["id"]
        else:
            assert codes == [], c["id"]
