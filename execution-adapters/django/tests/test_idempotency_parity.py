"""Cross-language idempotency parity: the Python adapter must reproduce the
shared canonical-JSON / fingerprint / scoped-key vectors byte-for-byte (the same
fixture the TypeScript and PHP adapters run)."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vds_form.idempotency import canonical_json, payload_fingerprint, scoped_idempotency_key

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "form-conformance", "fixtures", "idempotency.json")


def _fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def test_canonical_json_parity():
    for c in _fixture()["canonical"]:
        assert canonical_json(c["input"]) == c["expected"]


def test_fingerprint_parity():
    for c in _fixture()["fingerprint"]:
        assert payload_fingerprint(c["input"]) == c["expected"]


def test_scoped_key_parity():
    for c in _fixture()["scopedKey"]:
        i = c["input"]
        got = scoped_idempotency_key(tenant_id=i["tenantId"], user_id=i["userId"], form_id=i["formId"],
                                     operation_ref=i["operationRef"], idempotency_key=i["idempotencyKey"])
        assert got == c["expected"]
