"""Shared cross-language security policy vectors (Stage 2–4)."""
import json
from pathlib import Path

from vds_form.policy import (
    collect_unknown_property_issues, compute_read_policy, filter_readable_values,
    hidden_template_paths, strip_paths,
)

FIXTURE = Path(__file__).resolve().parents[3] / "packages" / "form-conformance" / "fixtures" / "security-paths.json"


def _ir(fields, field_access=None):
    return {"fields": fields, "security": {"fieldAccess": field_access or {}}}


class Rbac:
    def __init__(self, permissions):
        self.permissions = set(permissions)

    def evaluate(self, auth, required):
        missing = [p for p in required if p not in self.permissions]
        return {"allowed": not missing, "missing": missing}


def test_hidden_vectors():
    data = json.loads(FIXTURE.read_text())
    for c in data["hidden"]:
        ir = _ir(c["fields"])
        visibility = {f["id"]: f["id"] not in c["hiddenFieldIds"] for f in c["fields"]}
        actual = strip_paths(c["values"], hidden_template_paths(ir, visibility))
        assert actual == c["expected"], c["id"]


def test_unknown_vectors():
    data = json.loads(FIXTURE.read_text())
    for c in data["unknown"]:
        issues = collect_unknown_property_issues(_ir(c["fields"]), c["values"])
        codes = [i["code"] for i in issues]
        if c["expectCodes"]:
            for code in c["expectCodes"]:
                assert code in codes, c["id"]
        else:
            assert codes == [], c["id"]


def test_read_vectors():
    data = json.loads(FIXTURE.read_text())
    for c in data["read"]:
        ir = _ir(c["fields"], c["fieldAccess"])
        auth = {"userId": "u1", "tenantId": "t1", "roles": [], "permissions": c["permissions"]}
        rbac = Rbac(c["permissions"]) if c["rbac"] else None
        policy = compute_read_policy(ir, auth, rbac)
        actual = filter_readable_values(ir, c["values"], policy["denied"])
        assert actual == c["expected"], c["id"]
