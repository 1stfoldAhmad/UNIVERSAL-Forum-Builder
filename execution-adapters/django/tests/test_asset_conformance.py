"""Shared asset accept/size conformance — same fixture as TypeScript/PHP/natives."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vds_form.assets import asset_size_allowed, asset_type_allowed, file_extension, normalize_mime_type

FIXTURE = os.path.join(
    os.path.dirname(__file__), "..", "..", "..",
    "packages", "form-conformance", "fixtures", "asset-upload.json",
)


def test_shared_asset_fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        suite = json.load(fh)
    failures = []
    for c in suite["cases"]:
        got_type = asset_type_allowed({"name": c["name"], "mimeType": c["mimeType"]}, c["accept"])
        got_size = asset_size_allowed(c["sizeBytes"], c.get("maxSizeBytes"))
        if got_type != c["expect"]["typeAllowed"]:
            failures.append(f"{c['id']}: typeAllowed expected {c['expect']['typeAllowed']}, got {got_type}")
        if got_size != c["expect"]["sizeAllowed"]:
            failures.append(f"{c['id']}: sizeAllowed expected {c['expect']['sizeAllowed']}, got {got_size}")
    assert not failures, " | ".join(failures)


def test_helpers_match_canonical_rules():
    assert normalize_mime_type("IMAGE/JPEG") == "image/jpeg"
    assert normalize_mime_type("text/plain; charset=utf-8") == "text/plain"
    assert normalize_mime_type("image/jpg") == "image/jpeg"
    assert file_extension("photo.JPG") == "jpeg"
    assert file_extension("C:\\uploads\\x.pdf") == "pdf"
    assert file_extension(".gitignore") == ""
    # Regression: .jpg must match image/jpeg, not a MIME substring.
    assert asset_type_allowed({"name": "p.jpg", "mimeType": "image/jpeg"}, [".jpg"]) is True
    assert asset_type_allowed({"name": "p.png", "mimeType": "image/png"}, [".jpg"]) is False
