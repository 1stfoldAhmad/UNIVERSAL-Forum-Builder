/**
 * Browser hydration for server-rendered VDS forms (Node/Django/Laravel share
 * this contract). Enhances the no-JS HTML form with the full headless runtime:
 * conditions, formulas, repeaters, multi-step, validation, uploads, drafts and
 * offline queue via injected platform adapters. Submission always POSTs to the
 * trusted server endpoint; the client never executes business operations.
 */
import { FormController } from '@vds-form/runtime';
import type {
  DraftStorageAdapter, FormIR, NormalizedAsset, OfflineQueueAdapter,
  SubmissionResult, UploadProvider, UploadedAssetRef, ValidationIssue,
} from '@vds-form/types';
import { esc } from './html';

export interface HydrateOptions {
  uploadProvider?: UploadProvider;
  drafts?: DraftStorageAdapter;
  offlineQueue?: OfflineQueueAdapter;
  onResult?: (result: SubmissionResult) => void;
  fetch?: typeof fetch;
}

const idFor = (path: string) => `vds-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
const cssEsc = (s: string) => s.replace(/["\\]/g, '\\$&');

export function hydrateForms(root: ParentNode = document, opts: HydrateOptions = {}): FormController[] {
  const controllers: FormController[] = [];
  for (const form of Array.from(root.querySelectorAll<HTMLFormElement>('form[data-vds-form]'))) {
    const irScript = form.querySelector<HTMLScriptElement>('script[data-vds-ir]');
    const valScript = form.querySelector<HTMLScriptElement>('script[data-vds-values]');
    if (!irScript) continue;
    const ir = JSON.parse(irScript.textContent ?? '{}') as FormIR;
    const values = valScript ? JSON.parse(valScript.textContent ?? '{}') : {};
    const ctrl = new FormController({
      ir, initialValues: values,
      uploadProvider: opts.uploadProvider, drafts: opts.drafts, offlineQueue: opts.offlineQueue,
    });
    controllers.push(ctrl);
    void ctrl.initialize().then(() => bind(form, ctrl, opts));
  }
  return controllers;
}

function setStatus(form: HTMLFormElement, text: string, kind: 'success' | 'error' | 'info') {
  let el = form.querySelector<HTMLElement>('[data-vds-status]');
  if (!el) { el = document.createElement('p'); el.setAttribute('data-vds-status', ''); el.setAttribute('role', kind === 'error' ? 'alert' : 'status'); form.prepend(el); }
  el.className = kind === 'error' ? 'vds-error' : kind === 'success' ? 'vds-success' : 'vds-help';
  el.textContent = text;
}

function bind(form: HTMLFormElement, ctrl: FormController, opts: HydrateOptions) {
  const ir = ctrl.ir;
  const rowTemplates = new Map<string, string>();
  for (const rep of Array.from(form.querySelectorAll<HTMLElement>('[data-repeater]'))) {
    const first = rep.querySelector<HTMLElement>('[data-row-index="0"]');
    if (first) rowTemplates.set(rep.dataset.repeater!, first.outerHTML);
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  let step = 0;

  const applyState = () => {
    const snap = ctrl.getSnapshot();
    for (const rep of Array.from(form.querySelectorAll<HTMLElement>('[data-repeater]'))) {
      const rid = rep.dataset.repeater!;
      const field = ir.fields.find((f) => f.id === rid);
      const rowsEl = rep.querySelector<HTMLElement>(`[data-rows="${cssEsc(rid)}"]`);
      const template = rowTemplates.get(rid);
      if (!field || !rowsEl || !template) continue;
      const desired = snap.repeaterRows[rid] ?? [];
      const current = Array.from(rowsEl.querySelectorAll<HTMLElement>('[data-row-index]')).map((r) => r.dataset.rowId);
      if (JSON.stringify(current) === JSON.stringify(desired)) continue;
      const dashKey = field.key.replace(/\./g, '-');
      const escKey = field.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rowsEl.innerHTML = desired.map((rowId, i) => template
        .replace(new RegExp(`${escKey}\\.0\\.`, 'g'), `${field.key}.${i}.`)
        .replace(new RegExp(`${dashKey}-0-`, 'g'), `${dashKey}-${i}-`)
        .replace(/data-row-index="0"/g, `data-row-index="${i}"`)
        .replace(/data-row-id="[^"]*"/g, `data-row-id="${rowId}"`)).join('');
    }
    for (const wrap of Array.from(form.querySelectorAll<HTMLElement>('[data-path]'))) {
      const path = wrap.dataset.path!;
      const slice = ctrl.fieldSlice(path) as { visible: boolean; required: boolean };
      if (wrap.classList.contains('vds-field')) {
        wrap.hidden = !slice.visible;
        wrap.dataset.visible = String(slice.visible);
        const label = wrap.querySelector('.vds-required');
        if (slice.required && !label) wrap.querySelector('.vds-label')?.insertAdjacentHTML('beforeend', ' <span class="vds-required" aria-hidden="true">*</span>');
        if (!slice.required && label) label.remove();
      }
      for (const input of Array.from(wrap.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-vds-input]'))) {
        const p = input.dataset.vdsInput!;
        const s = ctrl.fieldSlice(p) as { disabled: boolean; readonly: boolean; value: unknown };
        input.disabled = s.disabled;
        if ('readOnly' in input) (input as HTMLInputElement).readOnly = s.readonly;
        if (document.activeElement === input) continue;
        if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = s.value === true;
        else if (input instanceof HTMLInputElement && input.type === 'radio') input.checked = String(input.value) === String(s.value);
        else if (input instanceof HTMLSelectElement && input.multiple) {
          const sel = Array.isArray(s.value) ? (s.value as unknown[]).map(String) : [];
          for (const o of Array.from(input.options)) o.selected = sel.includes(o.value);
        } else if (input.tagName === 'OUTPUT') input.textContent = s.value === null || s.value === undefined ? '—' : String(s.value);
        else if (input.type !== 'file') input.value = s.value === null || s.value === undefined ? '' : String(s.value);
      }
    }
    for (const el of Array.from(form.querySelectorAll('[data-error-for]'))) el.remove();
    for (const issue of snap.issues.filter((i) => i.severity === 'error')) renderIssue(form, issue);
    const steps = Array.from(form.querySelectorAll<HTMLElement>('[data-step]'));
    steps.forEach((s, i) => { s.hidden = i !== step; });
  };
  ctrl.subscribe(applyState);
  applyState();

  form.addEventListener('input', (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-vds-input]');
    if (!input) return;
    const path = input.dataset.vdsInput!;
    let value: unknown;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'radio') value = input.value;
    else if (input instanceof HTMLSelectElement && input.multiple) value = Array.from(input.selectedOptions).map((o) => o.value);
    else if (input.type === 'number' || input.type === 'range') value = input.value === '' ? null : Number(input.value);
    else if (input.type === 'file') { void uploadFiles(input, path); return; }
    else value = input.value;
    void ctrl.setFieldValue(path, value);
    if (opts.drafts) void ctrl.saveDraft();
  });
  form.addEventListener('focusin', (e) => { const i = (e.target as HTMLElement).closest<HTMLElement>('[data-vds-input]'); if (i) void ctrl.focus(i.dataset.vdsInput!); });
  form.addEventListener('focusout', (e) => { const i = (e.target as HTMLElement).closest<HTMLElement>('[data-vds-input]'); if (i) void ctrl.blur(i.dataset.vdsInput!); });

  async function uploadFiles(input: HTMLInputElement, path: string) {
    const files = Array.from(input.files ?? []);
    const provider = opts.uploadProvider;
    if (!files.length || !provider) return;
    setStatus(form, 'Uploading…', 'info');
    try {
      const refs: UploadedAssetRef[] = [];
      for (const file of files) {
        const asset: NormalizedAsset = {
          id: `${path}-${file.name}-${file.size}`, name: file.name, mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size, source: 'picker', localUri: URL.createObjectURL(file),
        };
        refs.push(await provider.upload({ asset }));
      }
      const field = ir.fields.find((f) => f.key === path);
      await ctrl.setFieldValue(path, field?.validation.multiple ? refs : refs[0]);
      setStatus(form, 'Upload complete.', 'success');
    } catch (err) {
      setStatus(form, err instanceof Error ? err.message : 'Upload failed', 'error');
    }
  }

  form.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'add-row') { e.preventDefault(); ctrl.addRepeaterItem(btn.dataset.repeater!); }
    else if (action === 'remove-row') { e.preventDefault(); ctrl.removeRepeaterItem(btn.dataset.repeater!, btn.dataset.rowId!); }
    else if (action === 'move-up' || action === 'move-down') {
      e.preventDefault();
      const i = Number(btn.dataset.rowIndex); const to = action === 'move-up' ? i - 1 : i + 1;
      const rows = ctrl.getSnapshot().repeaterRows[btn.dataset.repeater!] ?? [];
      if (to >= 0 && to < rows.length) ctrl.moveRepeaterItem(btn.dataset.repeater!, i, to);
    } else if (action === 'step-next') { e.preventDefault(); step = Math.min(step + 1, form.querySelectorAll('[data-step]').length - 1); applyState(); }
    else if (action === 'step-prev') { e.preventDefault(); step = Math.max(step - 1, 0); applyState(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { issues } = await ctrl.validate();
    applyState();
    if (issues.some((i) => i.severity === 'error')) { setStatus(form, 'Please correct the errors below.', 'error'); return; }
    const values = ctrl.getValues();
    const idempotencyKey = `vds-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (opts.offlineQueue && typeof navigator !== 'undefined' && !navigator.onLine) {
      await opts.offlineQueue.enqueue({
        id: idempotencyKey, operationRef: ir.submission?.operationRef ?? '', formId: ir.formId, formVersion: ir.formVersion,
        specVersion: ir.specVersion, scopeKey: 'default', values, idempotencyKey,
        createdAt: new Date().toISOString(), status: 'queued', attempts: 0, maxAttempts: 5,
      });
      setStatus(form, 'Saved offline; will submit when online.', 'success');
      return;
    }
    setStatus(form, 'Submitting…', 'info');
    try {
      const action = form.getAttribute('action') || window.location.pathname;
      const res = await fetchImpl(`${action}${action.includes('?') ? '&' : '?'}format=json`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ values, idempotencyKey }),
      });
      const result = await res.json() as SubmissionResult;
      opts.onResult?.(result);
      if (result.status === 'succeeded') setStatus(form, 'Submitted successfully.', 'success');
      else if (result.status === 'server-validation-failed') { setStatus(form, 'Please correct the errors below.', 'error'); for (const i of result.issues) renderIssue(form, i); }
      else setStatus(form, 'message' in result ? result.message : result.status, 'error');
    } catch (err) {
      setStatus(form, err instanceof Error ? err.message : 'Submission failed', 'error');
    }
  });
}

function renderIssue(form: HTMLFormElement, issue: ValidationIssue) {
  const wrap = form.querySelector<HTMLElement>(`[data-path="${cssEsc(issue.path)}"]`);
  if (!wrap) return;
  let box = wrap.querySelector<HTMLElement>(`[id="${cssEsc(idFor(issue.path))}-error"]`);
  if (!box) { box = document.createElement('div'); box.id = `${idFor(issue.path)}-error`; wrap.append(box); }
  box.insertAdjacentHTML('beforeend', `<p class="vds-error" role="alert" data-error-for="${esc(issue.path)}">${esc(issue.message)}</p>`);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !(window as unknown as { __vdsNoAutoHydrate?: boolean }).__vdsNoAutoHydrate) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrateForms());
  else hydrateForms();
}
