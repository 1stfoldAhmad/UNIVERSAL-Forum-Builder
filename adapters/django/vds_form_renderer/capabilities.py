"""Renderer capability manifest for the Django target (shared contract)."""
from __future__ import annotations

from typing import Any, Dict

SUPPORTED = [
    "text", "textarea", "email", "password", "url", "phone", "integer", "decimal",
    "currency", "percentage", "duration", "date", "time", "datetime", "select",
    "multiselect", "radio", "checkbox", "switch", "consent", "rating", "range",
    "color", "file", "image", "computed", "hidden", "group", "repeater", "barcode",
]

DJANGO_CAPABILITY_MANIFEST: Dict[str, Any] = {
    "target": "django",
    "contractVersion": "1.0.0",
    "fieldTypes": {t: {"fieldType": t, "supported": True} for t in SUPPORTED},
    "features": {
        "dragDrop": True, "filePicker": True, "camera": False, "offlineQueue": True,
        "draftPersistence": True, "multiStep": True, "repeaters": True, "richText": False, "signature": False,
    },
}
