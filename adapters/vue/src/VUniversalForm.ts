import { defineComponent, h, onUnmounted, ref, toRaw, type PropType, type VNode } from 'vue';
import { uploadAssetBatch, type FormController } from '@vds-form/runtime';
import type { LayoutNode, NormalizedField, SubmissionResult, UploadedAssetRef } from '@vds-form/types';
import { localize } from '@vds-form/validation';
import { useFormField, useFormSnapshot } from './composables';

const inputStyle = 'display:block;width:100%;padding:8px 10px;font-size:15px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;';
const labelStyle = 'display:block;font-weight:600;margin-bottom:4px;font-size:14px;';
const errorStyle = 'color:#c0392b;font-size:13px;margin-top:3px;';
const helpStyle = 'color:#555;font-size:13px;margin-top:3px;';
const btnStyle = 'background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;';
const btnSecondary = 'background:#e9e9e9;color:#222;border:none;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;';

/** Single field — its own component so only it re-renders on slice change. */
const VField = defineComponent({
  name: 'VField',
  props: {
    controller: { type: Object as PropType<FormController>, required: true },
    field: { type: Object as PropType<NormalizedField>, required: true },
    path: { type: String, required: true },
    locale: { type: String, required: true },
  },
  setup(props) {
    const ctrl = toRaw(props.controller);
    const slice = useFormField(ctrl, props.path);
    const uploadError = ref<string | null>(null);
    const uploading = ref(false);
    const fileInput = ref<HTMLInputElement | null>(null);

    const set = (v: unknown) => ctrl.setFieldValue(props.path, v);

    // Shared, partial-success-safe upload semantics (see @vds-form/runtime).
    // Each success is committed immediately, so a later failure keeps earlier assets.
    let batch: AbortController | null = null;
    const uploadIds = new Set<string>();
    onUnmounted(() => { batch?.abort(); batch = null; });

    const uploadFiles = async (files: FileList | File[], source: 'picker' | 'drag-drop' = 'picker') => {
      if (batch) return; // ignore re-entrant interactions; prevents duplicate uploads
      const ac = new AbortController();
      batch = ac;
      uploadError.value = null;
      uploading.value = true;
      const result = await uploadAssetBatch({
        files: Array.from(files).map((f) => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })),
        provider: ctrl.uploadProvider,
        constraints: { accept: props.field.validation.accept, maxSizeBytes: props.field.validation.maxSizeBytes },
        multiple: props.field.validation.multiple,
        source,
        currentValue: ctrl.getFieldValue(props.path),
        readValue: () => ctrl.getFieldValue(props.path),
        seenIdentities: uploadIds,
        auth: ctrl.auth,
        signal: ac.signal,
        commit: (v) => set(v),
      });
      if (batch !== ac) return;
      batch = null;
      uploading.value = false;
      uploadError.value = result.failures.length
        ? result.failures.map((f) => `${f.name ? `${f.name}: ` : ''}${f.message} [${f.code}]`).join(' ')
        : null;
    };

    return () => {
      const s = slice.value;
      const { field, path, locale, controller } = props;
      if (!s.visible || field.type === 'hidden') return null;
      const value = s.value;
      const strValue = value === null || value === undefined ? '' : String(value);
      const firstError = s.issues.find((i) => i.severity === 'error');
      const showError = firstError && (s.touched || controller.getSnapshot().submission.status !== 'idle');
      const id = `input-${path}`;
      const aria = {
        id,
        'aria-required': s.required || undefined,
        'aria-invalid': s.issues.length > 0 || undefined,
        'aria-describedby': showError ? `error-${path}` : undefined,
        disabled: s.disabled,
      };

      let control: VNode | VNode[];
      switch (field.type) {
        case 'textarea':
          control = h('textarea', { ...aria, style: inputStyle, rows: field.ui.rows ?? 4, value: strValue, readonly: s.readonly, 'data-testid': id, onInput: (e: Event) => set((e.target as HTMLTextAreaElement).value), onBlur: () => controller.blur(path) });
          break;
        case 'select': {
          const options = controller.getOptions(field.id);
          control = h('select', { ...aria, style: inputStyle, value: strValue, 'data-testid': id, onChange: (e: Event) => set((e.target as HTMLSelectElement).value) }, [
            h('option', { value: '' }, 'Select…'),
            ...options.map((o) => h('option', { value: String(o.value), key: String(o.value) }, localize(o.label, locale))),
          ]);
          break;
        }
        case 'multiselect': {
          const options = controller.getOptions(field.id);
          const selected = Array.isArray(value) ? (value as string[]) : [];
          control = h('select', { ...aria, style: inputStyle, multiple: true, 'data-testid': id, onChange: (e: Event) => set(Array.from((e.target as HTMLSelectElement).selectedOptions).map((o) => o.value)) },
            options.map((o) => h('option', { value: String(o.value), key: String(o.value), selected: selected.includes(String(o.value)) }, localize(o.label, locale))));
          break;
        }
        case 'radio': {
          const options = controller.getOptions(field.id);
          control = options.map((o) => h('label', { style: 'display:block;padding:3px 0;font-weight:400;', key: String(o.value) }, [
            h('input', { type: 'radio', name: `radio-${path}`, value: String(o.value), checked: value === o.value, disabled: s.disabled, 'data-testid': `radio-${path}-${String(o.value)}`, onChange: () => set(o.value) }),
            ` ${localize(o.label, locale)}`,
          ]));
          break;
        }
        case 'checkbox': case 'switch': case 'consent':
          control = h('input', { ...aria, type: 'checkbox', role: field.type === 'switch' ? 'switch' : 'checkbox', checked: value === true, disabled: s.disabled || s.readonly, 'data-testid': id, onChange: (e: Event) => set((e.target as HTMLInputElement).checked) });
          break;
        case 'rating': {
          const max = field.validation.max ?? 5;
          const num = typeof value === 'number' ? value : 0;
          control = Array.from({ length: max }, (_, i) => i + 1).map((n) => h('button', {
            type: 'button', key: n, 'aria-label': `${n} of ${max}`, 'data-testid': `rating-${path}-${n}`,
            style: `background:none;border:none;font-size:24px;cursor:pointer;color:${n <= num ? '#f5a623' : '#ccc'};`,
            onClick: () => !s.readonly && set(n),
          }, '★'));
          break;
        }
        case 'range':
          control = h('input', { ...aria, type: 'range', min: field.validation.min ?? 0, max: field.validation.max ?? 100, value: typeof value === 'number' ? value : field.validation.min ?? 0, 'data-testid': id, onInput: (e: Event) => set(Number((e.target as HTMLInputElement).value)) });
          break;
        case 'file': case 'image': {
          const current = value as UploadedAssetRef | UploadedAssetRef[] | null;
          const names = current ? (Array.isArray(current) ? current.map((a) => a.name).join(', ') : current.name) : '';
          control = h('div', {
            style: 'border:2px dashed #bbb;border-radius:8px;padding:14px;background:#fafafa;',
            'data-testid': `dropzone-${path}`,
            onDragover: (e: DragEvent) => e.preventDefault(),
            onDrop: (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer?.files) void uploadFiles(e.dataTransfer.files, 'drag-drop'); },
          }, [
            h('input', { ref: fileInput, ...aria, type: 'file', style: 'display:none;', accept: field.validation.accept?.join(','), multiple: field.validation.multiple, 'data-testid': `file-input-${path}`, onChange: (e: Event) => { const input = e.target as HTMLInputElement; const f = input.files; if (f && f.length) { const files = Array.from(f); input.value = ''; void uploadFiles(files, 'picker'); } } }),
            h('button', { type: 'button', style: btnSecondary, disabled: s.disabled || uploading.value, 'data-testid': `pick-${path}`, onClick: () => { fileInput.value?.click(); } }, uploading.value ? 'Uploading…' : 'Choose file'),
            names ? h('p', { style: helpStyle, 'data-testid': `asset-${path}` }, `${names} ✓ uploaded`) : null,
            uploadError.value ? h('p', { role: 'alert', style: errorStyle, 'data-testid': `upload-error-${path}` }, uploadError.value) : null,
          ].filter(Boolean) as VNode[]);
          break;
        }
        case 'computed':
          control = h('output', { id, style: `${inputStyle}background:#f4f6f8;font-weight:600;`, 'data-testid': `computed-${path}` }, value === null || value === undefined ? '—' : typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value));
          break;
        case 'date': case 'time': case 'datetime':
          control = h('input', { ...aria, type: field.type === 'datetime' ? 'datetime-local' : field.type, style: inputStyle, value: strValue, readonly: s.readonly, 'data-testid': id, onInput: (e: Event) => set((e.target as HTMLInputElement).value), onBlur: () => controller.blur(path) });
          break;
        case 'color':
          control = h('input', { ...aria, type: 'color', style: `${inputStyle}height:40px;padding:2px;`, value: strValue || '#000000', 'data-testid': id, onInput: (e: Event) => set((e.target as HTMLInputElement).value) });
          break;
        default: {
          const htmlType = field.type === 'email' ? 'email' : field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : field.type === 'phone' ? 'tel' : ['integer', 'decimal', 'currency', 'percentage', 'duration'].includes(field.type) ? 'number' : 'text';
          control = h('input', {
            ...aria, type: htmlType, style: inputStyle, value: strValue, readonly: s.readonly,
            step: field.type === 'integer' ? 1 : undefined, min: field.validation.min, max: field.validation.max,
            'data-testid': id,
            onInput: (e: Event) => { const v = (e.target as HTMLInputElement).value; set(htmlType === 'number' ? (v === '' ? null : Number(v)) : v); },
            onBlur: () => controller.blur(path),
          });
        }
      }

      return h('div', { style: 'margin-bottom:14px;', 'data-testid': `field-${path}` }, [
        h('label', { for: id, style: labelStyle }, [localize(field.label, locale), s.required ? h('span', { 'aria-hidden': 'true', style: 'color:#c0392b;' }, ' *') : null]),
        field.description ? h('p', { style: helpStyle }, localize(field.description, locale)) : null,
        ...(Array.isArray(control) ? control : [control]),
        showError ? h('p', { id: `error-${path}`, role: 'alert', style: errorStyle, 'data-testid': `error-${path}` }, firstError!.message) : null,
      ]);
    };
  },
});

export const VUniversalForm = defineComponent({
  name: 'VUniversalForm',
  props: {
    controller: { type: Object as PropType<FormController>, required: true },
    locale: { type: String, default: undefined },
    submitLabel: { type: String, default: undefined },
  },
  emits: { submitted: (r: SubmissionResult) => true },
  setup(props, { emit }) {
    const ctrl = toRaw(props.controller);
    const snap = useFormSnapshot(ctrl);
    const stepIndex = ref(0);
    // Layout state for tabs / accordion (canonical layout nodes).
    const tabIndex = ref<Record<string, number>>({});
    const openPanels = ref<Record<string, boolean>>({});
    const submitting = ref(false);

    const fieldById = new Map(ctrl.ir.fields.map((f) => [f.id, f]));
    const loc = () => props.locale ?? ctrl.ir.localization.defaultLocale;

    const renderField = (field: NormalizedField, path: string): VNode | null => {
      if (field.type === 'group') {
        const children = ctrl.ir.fields.filter((f) => f.parentId === field.id);
        return h('fieldset', { style: 'border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:14px;', 'data-testid': `group-${field.id}`, key: field.id }, [
          h('legend', { style: 'font-weight:700;padding:0 6px;' }, localize(field.label, loc())),
          ...children.map((c) => renderField(c, c.key)),
        ]);
      }
      if (field.type === 'repeater') {
        const rowIds = snap.value.repeaterRows[field.id] ?? [];
        const children = ctrl.ir.fields.filter((f) => f.parentId === field.id);
        const min = field.validation.minItems ?? 0;
        return h('fieldset', { style: 'border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:14px;', 'data-testid': `repeater-${field.id}`, key: field.id }, [
          h('legend', { style: 'font-weight:700;padding:0 6px;' }, localize(field.label, loc())),
          ...rowIds.map((rowId, index) => h('div', { style: 'border:1px solid #eee;border-radius:6px;padding:12px;margin-bottom:10px;', 'data-testid': `row-${field.id}-${rowId}`, key: rowId }, [
            h('div', { style: 'display:flex;justify-content:space-between;margin-bottom:6px;' }, [
              h('strong', { style: 'font-size:13px;color:#666;' }, `Entry ${index + 1}`),
              h('button', { type: 'button', style: `${btnSecondary}padding:2px 8px;color:#c0392b;`, disabled: rowIds.length <= min, 'data-testid': `remove-${rowId}`, onClick: () => ctrl.removeRepeaterItem(field.id, rowId) }, '✕'),
            ]),
            ...children.map((c) => renderField(c, c.key.replace(`${field.key}[]`, `${field.key}.${index}`))),
          ])),
          h('button', { type: 'button', style: btnSecondary, 'data-testid': `add-${field.id}`, onClick: () => ctrl.addRepeaterItem(field.id) }, '+ Add entry'),
        ]);
      }
      return h(VField, { controller: ctrl, field, path, locale: loc(), key: `${field.id}-${path}` });
    };

    const collectRefs = (node: LayoutNode | undefined): string[] =>
      node ? [...(node.fieldRefs ?? []), ...(node.children ?? []).flatMap(collectRefs)] : [];

    const renderLayout = (node: LayoutNode, key: string): VNode | null => {
      const title = node.title ? localize(node.title, loc()) : undefined;
      const fields = (node.fieldRefs ?? []).map((id) => { const f = fieldById.get(id); return f ? renderField(f, f.key) : null; }).filter(Boolean) as VNode[];
      if (node.type === 'steps') {
        const steps = (node.children ?? []).filter((c) => c.type === 'step' || c.type === 'summary');
        const current = steps[Math.min(stepIndex.value, steps.length - 1)];
        const isLast = stepIndex.value >= steps.length - 1;
        const stepIds = collectRefs(current);
        return h('div', { key, 'data-testid': 'wizard' }, [
          h('h3', { style: 'margin:0 0 12px;' }, current?.title ? localize(current.title, loc()) : `Step ${stepIndex.value + 1}`),
          current?.type === 'summary'
            ? h('dl', { 'data-testid': 'summary' }, ctrl.ir.fields.filter((f) => !f.parentId && !['group', 'repeater'].includes(f.type) && snap.value.visibility[f.id] !== false).map((f) => h('div', { style: 'display:flex;justify-content:space-between;padding:4px 0;', key: f.id }, [h('dt', { style: 'color:#555;' }, localize(f.label, loc())), h('dd', { style: 'margin:0;font-weight:600;' }, String(snap.value.values[f.key] ?? '—'))])))
            : renderLayout(current ?? { type: 'group' }, `${key}-cur`),
          h('div', { style: 'display:flex;justify-content:space-between;margin-top:10px;' }, [
            h('button', { type: 'button', style: btnSecondary, disabled: stepIndex.value === 0, 'data-testid': 'wizard-back', onClick: () => { stepIndex.value = Math.max(0, stepIndex.value - 1); } }, 'Back'),
            !isLast ? h('button', {
              type: 'button', style: btnStyle, 'data-testid': 'wizard-next',
              onClick: async () => {
                for (const id of stepIds) { const f = fieldById.get(id); if (f) ctrl.blur(f.key); }
                const result = await ctrl.validate();
                const errs = result.issues.some((i) => { const f = ctrl.ir.fields.find((x) => i.path === x.key || i.path.startsWith(`${x.key}.`)); return f && stepIds.includes(f.id) && i.severity === 'error'; });
                if (!errs) stepIndex.value += 1;
              },
            }, 'Next') : null,
          ]),
        ]);
      }
      if (node.type === 'tabs') {
        const tabs = node.children ?? [];
        if (!tabs.length) return null;
        const sel = Math.min(Math.max(tabIndex.value[key] ?? 0, 0), tabs.length - 1);
        return h('div', { key, 'data-testid': node.id ? `tabs-${node.id}` : 'tabs' }, [
          h('div', { role: 'tablist', style: 'display:flex;gap:4px;margin-bottom:10px;' }, tabs.map((t, i) => h('button', {
            key: t.id ?? i, type: 'button', role: 'tab', 'aria-selected': i === sel,
            'data-testid': `tab-${node.id ?? key}-${i}`,
            style: `padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:${i === sel ? '#eef2ff' : '#fff'};font-weight:${i === sel ? 600 : 400};`,
            onClick: () => { tabIndex.value = { ...tabIndex.value, [key]: i }; },
          }, t.title ? localize(t.title, loc()) : `Tab ${i + 1}`))),
          h('div', { role: 'tabpanel' }, [renderLayout(tabs[sel], `${key}-${sel}`)]),
        ]);
      }
      if (node.type === 'accordion') {
        return h('div', { key, 'data-testid': node.id ? `accordion-${node.id}` : 'accordion' }, (node.children ?? []).map((child, i) => {
          const panelKey = `${key}-${child.id ?? i}`;
          const open = openPanels.value[panelKey] ?? false;
          return h('div', { key: panelKey, style: 'border:1px solid #e0e0e0;border-radius:6px;margin-bottom:6px;' }, [
            h('button', {
              type: 'button', 'aria-expanded': open, 'data-testid': `accordion-toggle-${child.id ?? i}`,
              style: 'width:100%;text-align:left;padding:8px 12px;background:#fafafa;border:none;cursor:pointer;',
              onClick: () => { openPanels.value = { ...openPanels.value, [panelKey]: !open }; },
            }, child.title ? localize(child.title, loc()) : `Section ${i + 1}`),
            open ? h('div', { style: 'padding:12px;' }, [renderLayout(child, `${panelKey}-body`)]) : null,
          ]);
        }));
      }
      if (node.type === 'fieldset') {
        return h('fieldset', { key, 'data-testid': node.id ? `fieldset-${node.id}` : 'fieldset', style: 'border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:16px;' }, [
          title ? h('legend', null, title) : null,
          ...fields,
          ...(node.children ?? []).map((c, i) => renderLayout(c, `${key}-${i}`)),
        ]);
      }
      if (node.type === 'summary') {
        const ids = node.fieldRefs ?? [];
        const shown = ids.length
          ? ids.map((id) => fieldById.get(id)).filter(Boolean)
          : ctrl.ir.fields.filter((f) => !f.parentId && !['group', 'repeater'].includes(f.type));
        return h('dl', { key, 'data-testid': node.id ? `summary-${node.id}` : 'summary' },
          shown.filter((f) => f && snap.value.visibility[f.id] !== false && f.type !== 'hidden').map((f) => h('div', { key: f!.id, style: 'display:flex;justify-content:space-between;padding:4px 0;' }, [
            h('dt', { style: 'color:#555;' }, localize(f!.label, loc())),
            h('dd', { style: 'margin:0;font-weight:600;', 'data-testid': `summary-value-${f!.id}` }, String(snap.value.values[f!.key] ?? '—')),
          ])));
      }
      if (node.type === 'divider') return h('hr', { key, style: 'border:none;border-top:1px solid #e0e0e0;margin:14px 0;' });
      if (node.type === 'text') return h('p', { key, style: 'color:#444;' }, node.text ? localize(node.text, loc()) : '');
      if (node.type === 'repeater') { const f = node.repeaterRef ? fieldById.get(node.repeaterRef) : undefined; return f ? renderField(f, f.key) : null; }
      const knownLayout = new Set(['section', 'group', 'step', 'tab', 'row', 'columns']);
      const isRow = node.type === 'row' || node.type === 'columns';
      const cols = Math.max(1, (node.fieldRefs?.length ?? 0) + (node.children?.length ?? 0));
      const sectionStyle = isRow
        ? `margin-bottom:16px;display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;`
        : 'margin-bottom:16px;';
      return h('section', { key, style: sectionStyle, 'aria-label': title, 'data-testid': node.id ? `layout-${node.id}` : undefined }, [
        title ? h('h3', { style: 'margin:0 0 10px;' }, title) : null,
        !knownLayout.has(node.type) ? h('p', { role: 'note', 'data-testid': `unsupported-layout-${node.id ?? key}`, style: 'color:#8d6e00;' }, `Unsupported layout node: ${node.type}`) : null,
        ...fields,
        ...(node.children ?? []).map((c, i) => renderLayout(c, `${key}-${i}`)),
      ].filter(Boolean));
    };

    const doSubmit = async () => {
      submitting.value = true;
      try { emit('submitted', await ctrl.submit()); } finally { submitting.value = false; }
    };

    return () => {
      const s = snap.value;
      const errorIssues = s.issues.filter((i) => i.severity === 'error');
      const showSummary = (s.state === 'invalid' || s.submission.status === 'failed') && errorIssues.length > 0;
      const result = s.submission.result;
      return h('form', {
        novalidate: true, style: 'max-width:640px;margin:0 auto;padding:20px;font-family:system-ui,sans-serif;',
        'data-testid': 'universal-form', onSubmit: (e: Event) => { e.preventDefault(); void doSubmit(); },
      }, [
        h('h2', { style: 'margin-top:0;' }, ctrl.ir.formId),
        renderLayout(ctrl.ir.layout, 'root'),
        showSummary ? h('div', { role: 'alert', style: 'background:#fdecea;border-radius:8px;padding:12px;margin-bottom:12px;', 'data-testid': 'error-summary' }, [
          h('strong', { style: 'color:#c0392b;' }, `${errorIssues.length} problems to fix:`),
          h('ul', { style: 'margin:6px 0 0;padding-left:18px;' }, errorIssues.slice(0, 8).map((i, idx) => h('li', { style: 'color:#c0392b;font-size:13px;', key: idx }, `${i.message} (${i.path})`))),
        ]) : null,
        h('div', { 'aria-live': 'polite' }, [
          result?.status === 'succeeded' ? h('p', { style: 'color:#1b5e20;font-weight:600;background:#e8f5e9;padding:12px;border-radius:8px;', 'data-testid': 'submit-success' }, 'Submitted successfully.') : null,
          result?.status === 'queued-offline' ? h('p', { style: 'color:#8d6e00;background:#fff8e1;padding:12px;border-radius:8px;', 'data-testid': 'submit-queued' }, 'Saved offline — not yet submitted to the server.') : null,
          result && !['succeeded', 'queued-offline', 'validation-failed'].includes(result.status) ? h('p', { role: 'alert', style: 'color:#c0392b;background:#fdecea;padding:12px;border-radius:8px;', 'data-testid': 'submit-error' }, `Submission failed: ${'message' in result ? result.message : result.status}`) : null,
        ]),
        h('button', { type: 'button', style: btnStyle, disabled: submitting.value || s.state === 'submitting', 'aria-busy': submitting.value, 'data-testid': 'submit-button', onClick: () => void doSubmit() }, submitting.value || s.state === 'submitting' ? 'Submitting…' : props.submitLabel ?? 'Submit'),
      ]);
    };
  },
});
