import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from vds_form.validation import _validate_one

HERE = os.path.dirname(__file__)
FIXTURE = os.path.normpath(os.path.join(HERE, "..", "..", "..", "packages", "form-conformance", "fixtures", "uploads.json"))


def test_shared_upload_type_and_size_fixtures():
    with open(FIXTURE, encoding="utf-8") as stream:
        fixtures = json.load(stream)
    for case in fixtures["cases"]:
        field = {"id": "upload", "key": "upload", "type": "file", "valueType": "asset", "validation": {"accept": case["accept"]}}
        value = {"name": case["name"], "mimeType": case["mimeType"], "sizeBytes": 10, "assetRef": "provider-ref"}
        issues = _validate_one({"field": field, "concreteKey": "upload"}, {"upload": value}, {"visibility": {"upload": True}, "required": {}, "disabled": {}, "readonly": {}}, "change")
        actual = not any(issue["code"] == "ASSET_TYPE_REJECTED" for issue in issues)
        assert actual is case["allowed"], case["id"]
    assert all((case["sizeBytes"] <= case["maxSizeBytes"]) is case["allowed"] for case in fixtures["sizeBoundaries"])
