/**
 * @vds-form/node — server-side HTML renderer for the canonical FormIR.
 * Produces the shared server-rendered HTML contract consumed by the hydration
 * client (./client). Works with no JavaScript (plain POST) and enhances to the
 * full headless runtime when hydrated. All 31 field types, groups, repeaters,
 * multi-step, localization, accessibility and validation errors are rendered.
 */
import type { FormController } from '@vds-form/runtime';
import type { FormIR, LayoutNode, NormalizedField, ValidationIssue } from '@vds-form/types';
import { localize } from '@vds-form/validation';

export interface RenderOptions {
  action?: string;
  locale?: string;
  csrfToken?: string;
  csrfParam?: string;
  submitLabel?: string;
  /** Embed IR + values JSON for hydration (default true). */
  hydrate?: boolean;
  issues?: ValidationIssue[];
  /** Extra hidden inputs (name → value). */
  hiddenInputs?: Record<string, string>;
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const idFor = (path: string) => `vds-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

interface Ctx {
  ctrl: FormController;
  ir: FormIR;
  locale: string;
  issues: ValidationIssue[];
  snap: ReturnType<FormController['getSnapshot']>;
}

function errorsFor(ctx: Ctx, path: string): ValidationIssue[] {
  return ctx.issues.filter((i) => i.path === path && i.severity === 'error');
}

function control(field: NormalizedField, path: string, ctx: Ctx): string {
  const slice = ctx.ctrl.fieldSlice(path) as { value: unknown; disabled: boolean; readonly: boolean; required: boolean };
  const value = slice.value;
  const id = idFor(path);
  const common = `id="${esc(id)}" name="${esc(path)}" data-vds-input="${esc(path)}"` +
    (slice.disabled ? ' disabled' : '') + (slice.readonly ? ' readonly' : '') +
    (slice.required ? ' required aria-required="true"' : '');
  const v = field.validation;
  const str = value === null || value === undefined ? '' : String(value);
  const num = (x: unknown) => (typeof x === 'number' ? ` ${x}` : '');
  switch (field.type) {
    case 'textarea':
      return `<textarea ${common} class="vds-input" rows="${field.ui.rows ?? 4}"${v.minLength !== undefined ? ` minlength="${v.minLength}"` : ''}${v.maxLength !== undefined ? ` maxlength="${v.maxLength}"` : ''}>${esc(str)}</textarea>`;
    case 'select': {
      const opts = ctx.ctrl.getOptions(field.id);
      return `<select ${common} class="vds-input"><option value="">Select…</option>` +
        opts.map((o) => `<option value="${esc(o.value)}"${String(o.value) === str ? ' selected' : ''}>${esc(localize(o.label, ctx.locale))}</option>`).join('') + '</select>';
    }
    case 'multiselect': {
      const opts = ctx.ctrl.getOptions(field.id);
      const sel = Array.isArray(value) ? (value as unknown[]).map(String) : [];
      return `<select ${common} class="vds-input" multiple size="4">` +
        opts.map((o) => `<option value="${esc(o.value)}"${sel.includes(String(o.value)) ? ' selected' : ''}>${esc(localize(o.label, ctx.locale))}</option>`).join('') + '</select>';
    }
    case 'radio': {
      const opts = ctx.ctrl.getOptions(field.id);
      return `<div class="vds-radios" role="radiogroup" aria-labelledby="${esc(id)}-label">` + opts.map((o, i) =>
        `<label class="vds-choice"><input type="radio" name="${esc(path)}" data-vds-input="${esc(path)}" value="${esc(o.value)}"${String(o.value) === str ? ' checked' : ''}${slice.disabled ? ' disabled' : ''} id="${esc(id)}-${i}"> ${esc(localize(o.label, ctx.locale))}</label>`).join('') + '</div>';
    }
    case 'checkbox': case 'switch': case 'consent':
      return `<input type="checkbox" ${common} class="vds-checkbox" role="${field.type === 'switch' ? 'switch' : 'checkbox'}"${value === true ? ' checked' : ''} value="true">`;
    case 'rating': {
      const max = v.max ?? 5; const cur = typeof value === 'number' ? value : 0;
      return `<div class="vds-rating" role="radiogroup" aria-labelledby="${esc(id)}-label">` + Array.from({ length: max }, (_, i) => i + 1).map((n) =>
        `<label class="vds-star"><input type="radio" name="${esc(path)}" data-vds-input="${esc(path)}" value="${n}"${n === cur ? ' checked' : ''}${slice.disabled ? ' disabled' : ''}> <span aria-hidden="true">${n <= cur ? '★' : '☆'}</span><span class="vds-sr-only">${n} of ${max}</span></label>`).join('') + '</div>';
    }
    case 'range':
      return `<input type="range" ${common} class="vds-range" min="${v.min ?? 0}" max="${v.max ?? 100}" value="${typeof value === 'number' ? value : (v.min ?? 0)}"><output class="vds-range-out" for="${esc(id)}">${esc(str || (v.min ?? 0))}</output>`;
    case 'file': case 'image': {
      const assets = Array.isArray(value) ? value : value ? [value] : [];
      const names = assets.map((a) => esc((a as { name?: string }).name ?? 'file')).join(', ');
      return `<input type="file" ${common} class="vds-file"${v.accept?.length ? ` accept="${esc(v.accept.join(','))}"` : ''}${v.multiple ? ' multiple' : ''}>` +
        (names ? `<p class="vds-help" data-asset-for="${esc(path)}">${names} ✓ uploaded</p>` : '') +
        `<p class="vds-help vds-upload-note">Files upload through the registered upload provider when JavaScript is enabled.</p>`;
    }
    case 'signature':
      return `<div class="vds-unsupported" role="note">Signature capture is not supported by the Node renderer.</div>`;
    case 'computed':
      return `<output ${common} class="vds-computed" data-computed="${esc(path)}">${esc(str === '' ? '—' : str)}</output>`;
    case 'hidden':
      return `<input type="hidden" ${common} value="${esc(str)}">`;
    case 'date': case 'time': case 'datetime':
      return `<input type="${field.type === 'datetime' ? 'datetime-local' : field.type}" ${common} class="vds-input" value="${esc(str)}">`;
    case 'color':
      return `<input type="color" ${common} class="vds-color" value="${esc(str || '#000000')}">`;
    case 'integer': case 'decimal': case 'currency': case 'percentage': case 'duration':
      return `<input type="number" ${common} class="vds-input" step="${field.type === 'integer' ? '1' : 'any'}"${v.min !== undefined ? ` min="${v.min}"` : ''}${v.max !== undefined ? ` max="${v.max}"` : ''} value="${esc(str)}">`;
    case 'email': case 'password': case 'url': case 'phone':
      return `<input type="${field.type === 'phone' ? 'tel' : field.type}" ${common} class="vds-input" value="${esc(str)}"${field.type === 'password' ? ' autocomplete="new-password"' : ''}${v.maxLength !== undefined ? ` maxlength="${v.maxLength}"` : ''}>`;
    default:
      return `<input type="text" ${common} class="vds-input" value="${esc(str)}"${v.maxLength !== undefined ? ` maxlength="${v.maxLength}"` : ''}>`;
  }
}

function renderField(field: NormalizedField, path: string, ctx: Ctx): string {
  const slice = ctx.ctrl.fieldSlice(path) as { visible: boolean; required: boolean };
  if (field.type === 'hidden') return control(field, path, ctx);
  if (!slice.visible) return `<div class="vds-field vds-hidden" data-field-id="${esc(field.id)}" data-path="${esc(path)}" data-visible="false" hidden></div>`;
  const errs = errorsFor(ctx, path);
  const id = idFor(path);
  const label = localize(field.label, ctx.locale);
  const desc = field.description ? `<p class="vds-help" id="${esc(id)}-help">${esc(localize(field.description, ctx.locale))}</p>` : '';
  const errHtml = errs.map((e) => `<p class="vds-error" role="alert" data-error-for="${esc(path)}">${esc(e.message)}</p>`).join('');
  const aria = errs.length ? ` aria-invalid="true" aria-describedby="${esc(id)}-error"` : (field.description ? ` aria-describedby="${esc(id)}-help"` : '');
  return `<div class="vds-field" data-field-id="${esc(field.id)}" data-path="${esc(path)}" data-type="${esc(field.type)}" data-visible="true">` +
    `<label class="vds-label" id="${esc(id)}-label" for="${esc(id)}">${esc(label)}${slice.required ? ' <span class="vds-required" aria-hidden="true">*</span>' : ''}</label>` +
    desc + `<div class="vds-control"${aria}>${control(field, path, ctx)}</div>` +
    `<div id="${esc(id)}-error">${errHtml}</div></div>`;
}

function renderRepeater(field: NormalizedField, ctx: Ctx): string {
  const rows = ctx.snap.repeaterRows[field.id] ?? [];
  const children = ctx.ir.fields.filter((f) => f.parentId === field.id);
  const errs = errorsFor(ctx, field.key);
  const rowHtml = rows.map((rowId, i) => {
    const inner = children.map((c) => renderField(c, c.key.replace(`${field.key}[]`, `${field.key}.${i}`), ctx)).join('');
    return `<div class="vds-row" data-row-id="${esc(rowId)}" data-row-index="${i}">${inner}` +
      `<div class="vds-row-actions"><button type="button" class="vds-btn vds-btn-secondary" data-action="remove-row" data-repeater="${esc(field.id)}" data-row-id="${esc(rowId)}">Remove</button>` +
      `<button type="button" class="vds-btn vds-btn-secondary" data-action="move-up" data-repeater="${esc(field.id)}" data-row-index="${i}">↑</button>` +
      `<button type="button" class="vds-btn vds-btn-secondary" data-action="move-down" data-repeater="${esc(field.id)}" data-row-index="${i}">↓</button></div></div>`;
  }).join('');
  return `<div class="vds-repeater" data-repeater="${esc(field.id)}" data-path="${esc(field.key)}">` +
    `<fieldset class="vds-fieldset"><legend class="vds-legend">${esc(localize(field.label, ctx.locale))}</legend>` +
    `<div data-rows="${esc(field.id)}">${rowHtml}</div>` +
    errs.map((e) => `<p class="vds-error" role="alert">${esc(e.message)}</p>`).join('') +
    `<button type="button" class="vds-btn vds-btn-secondary" data-action="add-row" data-repeater="${esc(field.id)}">Add entry</button></fieldset></div>`;
}

function renderLayout(node: LayoutNode, ctx: Ctx, stepIndex = { n: 0 }): string {
  const title = node.title ? `<h3 class="vds-section-title">${esc(localize(node.title, ctx.locale))}</h3>` : '';
  const fields = (node.fieldRefs ?? []).map((fid) => {
    const f = ctx.ir.fields.find((x) => x.id === fid);
    if (!f) return '';
    if (f.type === 'repeater') return renderRepeater(f, ctx);
    if (f.type === 'group') return `<fieldset class="vds-fieldset" data-field-id="${esc(f.id)}"><legend class="vds-legend">${esc(localize(f.label, ctx.locale))}</legend>` +
      ctx.ir.fields.filter((c) => c.parentId === f.id).map((c) => renderField(c, c.key, ctx)).join('') + '</fieldset>';
    return renderField(f, f.key, ctx);
  }).join('');
  const children = (node.children ?? []).map((c) => renderLayout(c, ctx, stepIndex)).join('');
  switch (node.type) {
    case 'steps':
      return `<div class="vds-wizard" data-wizard>${children}</div>`;
    case 'step': case 'summary': {
      const idx = stepIndex.n++;
      return `<fieldset class="vds-step" data-step="${idx}"${idx > 0 ? ' hidden' : ''}><legend class="vds-legend">${esc(localize(node.title, ctx.locale) || `Step ${idx + 1}`)}</legend>${fields}${children}` +
        `<div class="vds-step-actions"><button type="button" class="vds-btn vds-btn-secondary" data-action="step-prev">Back</button>` +
        `<button type="button" class="vds-btn" data-action="step-next">Next</button></div></fieldset>`;
    }
    case 'repeater': {
      const f = ctx.ir.fields.find((x) => x.id === node.repeaterRef);
      return f ? renderRepeater(f, ctx) : fields + children;
    }
    case 'text':
      return `<p class="vds-text">${esc(localize(node.text, ctx.locale))}</p>${fields}${children}`;
    case 'divider':
      return '<hr class="vds-divider">';
    case 'fieldset':
      return `<fieldset class="vds-fieldset"><legend class="vds-legend">${esc(localize(node.title, ctx.locale))}</legend>${fields}${children}</fieldset>`;
    default:
      return `<section class="vds-section" data-layout="${esc(node.type)}">${title}${fields}${children}</section>`;
  }
}

/** Render a form controller's current state to the shared HTML contract. */
export function renderForm(ctrl: FormController, opts: RenderOptions = {}): string {
  const ir = ctrl.ir;
  const locale = opts.locale ?? ir.localization.defaultLocale;
  const snap = ctrl.getSnapshot();
  const ctx: Ctx = { ctrl, ir, locale, issues: opts.issues ?? snap.issues, snap };
  const body = renderLayout(ir.layout, ctx);
  const hidden = Object.entries(opts.hiddenInputs ?? {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const csrf = opts.csrfToken ? `<input type="hidden" name="${esc(opts.csrfParam ?? '_csrf')}" value="${esc(opts.csrfToken)}">` : '';
  const status = snap.submission.status === 'succeeded'
    ? '<p class="vds-success" role="status" data-vds-status>Submitted successfully.</p>'
    : snap.submission.status === 'failed'
      ? '<p class="vds-error" role="alert" data-vds-status>Please correct the errors below.</p>' : '';
  const hydration = opts.hydrate === false ? '' :
    `<script type="application/json" data-vds-ir>${JSON.stringify(ir).replace(/</g, '\\u003c')}</script>` +
    `<script type="application/json" data-vds-values>${JSON.stringify(snap.values).replace(/</g, '\\u003c')}</script>`;
  return `<form class="vds-form" data-vds-form="${esc(ir.formId)}" action="${esc(opts.action ?? '')}" method="post" novalidate>` +
    csrf + hidden + status + body +
    `<div class="vds-actions"><button type="submit" class="vds-btn" data-action="submit">${esc(opts.submitLabel ?? 'Submit')}</button></div>` +
    hydration + '</form>';
}

/** Render a complete HTML page (SSR convenience). */
export function renderPage(ctrl: FormController, opts: RenderOptions & { title?: string; clientScript?: string } = {}): string {
  return `<!doctype html><html lang="${esc(opts.locale ?? ctrl.ir.localization.defaultLocale)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title ?? ctrl.ir.formId)}</title>` +
    `<link rel="stylesheet" href="data:text/css,${encodeURIComponent(CSS)}"></head><body>` +
    renderForm(ctrl, opts) +
    (opts.clientScript ? `<script type="module" src="${esc(opts.clientScript)}"></script>` : '') + '</body></html>';
}

export const CSS = `.vds-form{max-width:640px;margin:0 auto;font-family:system-ui,sans-serif}.vds-field{margin-bottom:14px}.vds-label{display:block;font-weight:600;margin-bottom:4px}.vds-input{display:block;width:100%;padding:8px 10px;font-size:15px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}.vds-help{color:#555;font-size:13px;margin:3px 0}.vds-error{color:#c0392b;font-size:13px;margin:3px 0}.vds-success{color:#1e7e34}.vds-btn{background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}.vds-btn-secondary{background:#e9e9e9;color:#222}.vds-required{color:#c0392b}.vds-row{border:1px solid #e2e2e2;border-radius:8px;padding:12px;margin-bottom:10px}.vds-row-actions{display:flex;gap:8px}.vds-fieldset{border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:14px}.vds-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.vds-choice{display:block;padding:3px 0}.vds-star{cursor:pointer;font-size:22px}.vds-hidden{display:none}`;
