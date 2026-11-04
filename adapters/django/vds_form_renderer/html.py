"""Server-side HTML renderer producing the shared VDS server-rendered contract.

Mirrors adapters/node/src/html.ts so the same hydration client enhances Node,
Django and Laravel output. Framework-free (returns strings); Django integration
lives in views.py / templatetags.
"""
from __future__ import annotations

import html as _html
import json
import re
from typing import Any, Dict, List

from vds_form.expressions import get_path

from .state import prepare_render_state

CSS = (
    ".vds-form{max-width:640px;margin:0 auto;font-family:system-ui,sans-serif}"
    ".vds-field{margin-bottom:14px}.vds-label{display:block;font-weight:600;margin-bottom:4px}"
    ".vds-input{display:block;width:100%;padding:8px 10px;font-size:15px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}"
    ".vds-help{color:#555;font-size:13px;margin:3px 0}.vds-error{color:#c0392b;font-size:13px;margin:3px 0}"
    ".vds-success{color:#1e7e34}.vds-btn{background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}"
    ".vds-btn-secondary{background:#e9e9e9;color:#222}.vds-required{color:#c0392b}"
    ".vds-row{border:1px solid #e2e2e2;border-radius:8px;padding:12px;margin-bottom:10px}.vds-row-actions{display:flex;gap:8px}"
    ".vds-fieldset{border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:14px}"
    ".vds-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}"
    ".vds-choice{display:block;padding:3px 0}.vds-star{cursor:pointer;font-size:22px}.vds-hidden{display:none}"
)


def esc(value: Any) -> str:
    return _html.escape("" if value is None else str(value), quote=True)


def localize(text: Any, locale: str, fallback: str = "en") -> str:
    if text is None:
        return ""
    if isinstance(text, str):
        return text
    if isinstance(text, dict):
        return text.get(locale) or text.get(fallback) or next(iter(text.values()), "")
    return str(text)


def _id_for(path: str) -> str:
    return "vds-" + re.sub(r"[^a-zA-Z0-9_-]", "-", path)


def _errors_for(ctx: Dict[str, Any], path: str) -> List[Dict[str, Any]]:
    return [i for i in ctx["issues"] if i.get("path") == path and i.get("severity") == "error"]


def _control(field: Dict[str, Any], path: str, ctx: Dict[str, Any]) -> str:
    value = get_path(ctx["values"], path)
    fid = _id_for(path)
    state = ctx["state"]
    disabled = state["disabled"].get(field["id"], False)
    readonly = state["readonly"].get(field["id"], False) or field.get("computed", False)
    required = state["required"].get(field["id"], False)
    common = f'id="{esc(fid)}" name="{esc(path)}" data-vds-input="{esc(path)}"'
    if disabled:
        common += " disabled"
    if readonly:
        common += " readonly"
    if required:
        common += ' required aria-required="true"'
    v = field.get("validation", {})
    s = "" if value is None else str(value)
    t = field["type"]
    if t == "textarea":
        return f'<textarea {common} class="vds-input" rows="{field.get("ui", {}).get("rows", 4)}">{esc(s)}</textarea>'
    if t in ("select", "multiselect"):
        opts = field.get("options") or []
        sel = [str(x) for x in value] if isinstance(value, list) else []
        multi = " multiple size=\"4\"" if t == "multiselect" else ""
        head = "" if t == "multiselect" else '<option value="">Select…</option>'
        body = "".join(
            f'<option value="{esc(o["value"])}"{" selected" if (str(o["value"]) in sel if t == "multiselect" else str(o["value"]) == s) else ""}>{esc(localize(o.get("label"), ctx["locale"]))}</option>'
            for o in opts if isinstance(o, dict)
        )
        return f'<select {common} class="vds-input"{multi}>{head}{body}</select>'
    if t == "radio":
        opts = field.get("options") or []
        inner = "".join(
            f'<label class="vds-choice"><input type="radio" name="{esc(path)}" data-vds-input="{esc(path)}" value="{esc(o["value"])}"{" checked" if str(o["value"]) == s else ""}{" disabled" if disabled else ""}> {esc(localize(o.get("label"), ctx["locale"]))}</label>'
            for o in opts if isinstance(o, dict)
        )
        return f'<div class="vds-radios" role="radiogroup">{inner}</div>'
    if t in ("checkbox", "switch", "consent"):
        role = "switch" if t == "switch" else "checkbox"
        return f'<input type="checkbox" {common} class="vds-checkbox" role="{role}"{" checked" if value is True else ""} value="true">'
    if t == "rating":
        mx = int(v.get("max", 5)); cur = value if isinstance(value, (int, float)) else 0
        inner = "".join(
            f'<label class="vds-star"><input type="radio" name="{esc(path)}" data-vds-input="{esc(path)}" value="{n}"{" checked" if n == cur else ""}> <span aria-hidden="true">{"★" if n <= cur else "☆"}</span></label>'
            for n in range(1, mx + 1)
        )
        return f'<div class="vds-rating" role="radiogroup">{inner}</div>'
    if t == "range":
        mn = v.get("min", 0); mx = v.get("max", 100)
        return f'<input type="range" {common} class="vds-range" min="{mn}" max="{mx}" value="{value if isinstance(value, (int, float)) else mn}"><output class="vds-range-out">{esc(s or mn)}</output>'
    if t in ("file", "image"):
        accept = f' accept="{esc(",".join(v["accept"]))}"' if v.get("accept") else ""
        multiple = " multiple" if v.get("multiple") else ""
        return f'<input type="file" {common} class="vds-file"{accept}{multiple}><p class="vds-help vds-upload-note">Files upload through the registered upload provider when JavaScript is enabled.</p>'
    if t == "signature":
        return '<div class="vds-unsupported" role="note">Signature capture is not supported by the Django renderer.</div>'
    if t == "computed":
        return f'<output {common} class="vds-computed" data-computed="{esc(path)}">{esc(s if s != "" else "—")}</output>'
    if t == "hidden":
        return f'<input type="hidden" {common} value="{esc(s)}">'
    if t in ("date", "time", "datetime"):
        it = "datetime-local" if t == "datetime" else t
        return f'<input type="{it}" {common} class="vds-input" value="{esc(s)}">'
    if t == "color":
        return f'<input type="color" {common} class="vds-color" value="{esc(s or "#000000")}">'
    if t in ("integer", "decimal", "currency", "percentage", "duration"):
        step = "1" if t == "integer" else "any"
        mn = f' min="{v["min"]}"' if v.get("min") is not None else ""
        mx = f' max="{v["max"]}"' if v.get("max") is not None else ""
        return f'<input type="number" {common} class="vds-input" step="{step}"{mn}{mx} value="{esc(s)}">'
    if t in ("email", "password", "url", "phone"):
        it = "tel" if t == "phone" else t
        return f'<input type="{it}" {common} class="vds-input" value="{esc(s)}">'
    ml = f' maxlength="{v["maxLength"]}"' if v.get("maxLength") is not None else ""
    return f'<input type="text" {common} class="vds-input" value="{esc(s)}"{ml}>'


def _render_field(field: Dict[str, Any], path: str, ctx: Dict[str, Any]) -> str:
    if field["type"] == "hidden":
        return _control(field, path, ctx)
    visible = ctx["state"]["visibility"].get(field["id"], True)
    if not visible:
        return f'<div class="vds-field vds-hidden" data-field-id="{esc(field["id"])}" data-path="{esc(path)}" data-visible="false" hidden></div>'
    fid = _id_for(path)
    required = ctx["state"]["required"].get(field["id"], False)
    label = localize(field.get("label"), ctx["locale"])
    desc = f'<p class="vds-help" id="{esc(fid)}-help">{esc(localize(field.get("description"), ctx["locale"]))}</p>' if field.get("description") else ""
    errs = "".join(f'<p class="vds-error" role="alert" data-error-for="{esc(path)}">{esc(e["message"])}</p>' for e in _errors_for(ctx, path))
    star = ' <span class="vds-required" aria-hidden="true">*</span>' if required else ""
    return (
        f'<div class="vds-field" data-field-id="{esc(field["id"])}" data-path="{esc(path)}" data-type="{esc(field["type"])}" data-visible="true">'
        f'<label class="vds-label" id="{esc(fid)}-label" for="{esc(fid)}">{esc(label)}{star}</label>{desc}'
        f'<div class="vds-control">{_control(field, path, ctx)}</div><div id="{esc(fid)}-error">{errs}</div></div>'
    )


def _render_repeater(field: Dict[str, Any], ctx: Dict[str, Any]) -> str:
    rows = ctx["repeater_rows"].get(field["id"], [])
    children = [f for f in ctx["ir"]["fields"] if f.get("parentId") == field["id"]]
    row_html = ""
    for i in rows:
        inner = "".join(_render_field(c, c["key"].replace(f'{field["key"]}[]', f'{field["key"]}.{i}'), ctx) for c in children)
        row_html += (
            f'<div class="vds-row" data-row-id="row-{i}" data-row-index="{i}">{inner}'
            f'<div class="vds-row-actions"><button type="button" class="vds-btn vds-btn-secondary" data-action="remove-row" data-repeater="{esc(field["id"])}" data-row-id="row-{i}">Remove</button></div></div>'
        )
    errs = "".join(f'<p class="vds-error" role="alert">{esc(e["message"])}</p>' for e in _errors_for(ctx, field["key"]))
    return (
        f'<div class="vds-repeater" data-repeater="{esc(field["id"])}" data-path="{esc(field["key"])}">'
        f'<fieldset class="vds-fieldset"><legend class="vds-legend">{esc(localize(field.get("label"), ctx["locale"]))}</legend>'
        f'<div data-rows="{esc(field["id"])}">{row_html}</div>{errs}'
        f'<button type="button" class="vds-btn vds-btn-secondary" data-action="add-row" data-repeater="{esc(field["id"])}">Add entry</button></fieldset></div>'
    )


def _render_layout(node: Dict[str, Any], ctx: Dict[str, Any], step_index: List[int]) -> str:
    title = f'<h3 class="vds-section-title">{esc(localize(node.get("title"), ctx["locale"]))}</h3>' if node.get("title") else ""
    fields = ""
    for fid in node.get("fieldRefs", []):
        f = next((x for x in ctx["ir"]["fields"] if x["id"] == fid), None)
        if not f:
            continue
        if f["type"] == "repeater":
            fields += _render_repeater(f, ctx)
        elif f["type"] == "group":
            inner = "".join(_render_field(c, c["key"], ctx) for c in ctx["ir"]["fields"] if c.get("parentId") == f["id"])
            fields += f'<fieldset class="vds-fieldset" data-field-id="{esc(f["id"])}"><legend class="vds-legend">{esc(localize(f.get("label"), ctx["locale"]))}</legend>{inner}</fieldset>'
        else:
            fields += _render_field(f, f["key"], ctx)
    children = "".join(_render_layout(c, ctx, step_index) for c in node.get("children", []))
    nt = node.get("type")
    if nt == "steps":
        return f'<div class="vds-wizard" data-wizard>{children}</div>'
    if nt in ("step", "summary"):
        idx = step_index[0]; step_index[0] += 1
        hidden = " hidden" if idx > 0 else ""
        legend = esc(localize(node.get("title"), ctx["locale"]) or f"Step {idx + 1}")
        return (f'<fieldset class="vds-step" data-step="{idx}"{hidden}><legend class="vds-legend">{legend}</legend>{fields}{children}'
                f'<div class="vds-step-actions"><button type="button" class="vds-btn vds-btn-secondary" data-action="step-prev">Back</button>'
                f'<button type="button" class="vds-btn" data-action="step-next">Next</button></div></fieldset>')
    if nt == "repeater":
        f = next((x for x in ctx["ir"]["fields"] if x["id"] == node.get("repeaterRef")), None)
        return _render_repeater(f, ctx) if f else fields + children
    if nt == "text":
        return f'<p class="vds-text">{esc(localize(node.get("text"), ctx["locale"]))}</p>{fields}{children}'
    if nt == "divider":
        return '<hr class="vds-divider">'
    if nt == "fieldset":
        return f'<fieldset class="vds-fieldset"><legend class="vds-legend">{esc(localize(node.get("title"), ctx["locale"]))}</legend>{fields}{children}</fieldset>'
    return f'<section class="vds-section" data-layout="{esc(nt)}">{title}{fields}{children}</section>'


def render_form(ir: Dict[str, Any], values: Dict[str, Any] | None = None, issues: List[Dict[str, Any]] | None = None,
                locale: str | None = None, action: str = "", csrf_token: str | None = None,
                csrf_param: str = "csrfmiddlewaretoken", submit_label: str = "Submit",
                hydrate: bool = True, hidden_inputs: Dict[str, str] | None = None) -> str:
    prepared = prepare_render_state(ir, values)
    loc = locale or ir.get("localization", {}).get("defaultLocale", "en")
    ctx = {"ir": ir, "values": prepared["values"], "state": prepared["state"],
           "repeater_rows": prepared["repeater_rows"], "locale": loc, "issues": issues or []}
    body = _render_layout(ir["layout"], ctx, [0])
    hidden = "".join(f'<input type="hidden" name="{esc(k)}" value="{esc(v)}">' for k, v in (hidden_inputs or {}).items())
    csrf = f'<input type="hidden" name="{esc(csrf_param)}" value="{esc(csrf_token)}">' if csrf_token else ""
    hydration = ""
    if hydrate:
        ir_json = json.dumps(ir).replace("<", "\\u003c")
        values_json = json.dumps(prepared["values"]).replace("<", "\\u003c")
        hydration = (f'<script type="application/json" data-vds-ir>{ir_json}</script>'
                     f'<script type="application/json" data-vds-values>{values_json}</script>')
    return (f'<form class="vds-form" data-vds-form="{esc(ir["formId"])}" action="{esc(action)}" method="post" novalidate>'
            f'{csrf}{hidden}{body}<div class="vds-actions"><button type="submit" class="vds-btn" data-action="submit">{esc(submit_label)}</button></div>{hydration}</form>')


def render_page(ir: Dict[str, Any], title: str | None = None, client_script: str | None = None, **kwargs: Any) -> str:
    loc = kwargs.get("locale") or ir.get("localization", {}).get("defaultLocale", "en")
    script = f'<script type="module" src="{esc(client_script)}"></script>' if client_script else ""
    return (f'<!doctype html><html lang="{esc(loc)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{esc(title or ir["formId"])}</title><style>{CSS}</style></head><body>{render_form(ir, **kwargs)}{script}</body></html>')
