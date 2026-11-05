"""Canonical asset (file/image) constraint semantics — Python port.

Mirrors packages/form-validation/src/assets.ts exactly and is proven against the
shared fixture packages/form-conformance/fixtures/asset-upload.json.

Extensions match the FILENAME; MIME tokens match a NORMALIZED MIME; either may be
inferred from the other. The size limit is inclusive.

SECURITY: client metadata is a hint, never proof of content. The trusted
upload/storage provider remains authoritative.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

MIME_ALIASES: Dict[str, str] = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/x-png": "image/png",
    "application/x-pdf": "application/pdf",
    "application/acrobat": "application/pdf",
}

EXT_ALIASES: Dict[str, str] = {"jpg": "jpeg", "jpe": "jpeg", "tif": "tiff", "htm": "html"}

EXT_TO_MIME: Dict[str, str] = {
    "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
    "bmp": "image/bmp", "heic": "image/heic", "heif": "image/heif", "svg": "image/svg+xml",
    "pdf": "application/pdf", "txt": "text/plain", "csv": "text/csv", "json": "application/json",
    "mp4": "video/mp4", "mov": "video/quicktime", "mp3": "audio/mpeg", "wav": "audio/wav",
    "zip": "application/zip", "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

MIME_TO_EXTS: Dict[str, List[str]] = {}
for _ext, _mime in EXT_TO_MIME.items():
    MIME_TO_EXTS.setdefault(_mime, []).append(EXT_ALIASES.get(_ext, _ext))

_GENERIC_MIME = "application/octet-stream"


def normalize_mime_type(mime_type: Optional[str]) -> str:
    if not mime_type:
        return ""
    base = str(mime_type).split(";")[0].strip().lower()
    return MIME_ALIASES.get(base, base)


def file_extension(name: Optional[str]) -> str:
    if not name:
        return ""
    base = str(name).replace("\\", "/").split("/")[-1]
    dot = base.rfind(".")
    if dot <= 0 or dot == len(base) - 1:
        return ""
    ext = base[dot + 1:].lower()
    return EXT_ALIASES.get(ext, ext)


def asset_type_allowed(asset: Dict[str, Any], accept: Optional[Iterable[str]]) -> bool:
    tokens = list(accept or [])
    if not tokens:
        return True

    mime = normalize_mime_type(asset.get("mimeType"))
    ext = file_extension(asset.get("name"))

    mimes = set()
    if mime and mime != _GENERIC_MIME:
        mimes.add(mime)
    if ext and ext in EXT_TO_MIME:
        mimes.add(EXT_TO_MIME[ext])

    exts = set()
    if ext:
        exts.add(ext)
    for e in MIME_TO_EXTS.get(mime, []):
        exts.add(e)

    for raw in tokens:
        token = str(raw).strip().lower()
        if not token:
            continue
        if token.startswith("."):
            want = token[1:]
            if EXT_ALIASES.get(want, want) in exts:
                return True
        elif token.endswith("/*"):
            prefix = token[:-1]
            if any(m.startswith(prefix) for m in mimes):
                return True
        elif normalize_mime_type(token) in mimes:
            return True
    return False


def asset_size_allowed(size_bytes: Any, max_size_bytes: Optional[float]) -> bool:
    if max_size_bytes is None:
        return True
    if not isinstance(size_bytes, (int, float)) or isinstance(size_bytes, bool):
        return True
    return size_bytes <= max_size_bytes
