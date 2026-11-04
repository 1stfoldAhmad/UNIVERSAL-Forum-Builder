import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { FormController } from '@vds-form/runtime';
import type { LayoutNode, NormalizedField, SubmissionResult, UploadedAssetRef } from '@vds-form/types';
import { localize } from '@vds-form/validation';
import { useField, useFormSnapshot } from './hooks';

export interface UniversalFormProps {
  controller: FormController;
  locale?: string;
  onSubmitted?: (result: SubmissionResult) => void;
  submitLabel?: string;
  className?: string;
}

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 10px', fontSize: 15,
  border: '1px solid #bbb', borderRadius: 6, boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 600, marginBottom: 4, fontSize: 14 };
const errorStyle: React.CSSProperties = { color: '#c0392b', fontSize: 13, marginTop: 3 };
const helpStyle: React.CSSProperties = { color: '#555', fontSize: 13, marginTop: 3 };
const btnStyle: React.CSSProperties = {
  background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 6,
  padding: '10px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
const btnSecondary: React.CSSProperties = { ...btnStyle, background: '#e9e9e9', color: '#222' };

interface FieldCtx { controller: FormController; locale: string }

function FieldWrap({ controller, field, path, locale, children }: FieldCtx & { field: NormalizedField; path: string; children: React.ReactNode }) {
  const slice = useField(controller, path);
  if (!slice.visible) return null;
  const snap = controller.getSnapshot();
  const firstError = slice.issues.find((i) => i.severity === 'error');
  const showError = firstError && (slice.touched || snap.submission.status !== 'idle');
  return (
    <div style={{ marginBottom: 14 }} data-testid={`field-${path}`}>
      <label htmlFor={`input-${path}`} style={labelStyle}>
        {localize(field.label, locale)}{slice.required ? <span aria-hidden="true" style={{ color: '#c0392b' }}> *</span> : null}
      </label>
      {field.description ? <p id={`desc-${path}`} style={helpStyle}>{localize(field.description, locale)}</p> : null}
      {children}
      {field.ui.helpText ? <p id={`help-${path}`} style={helpStyle}>{localize(field.ui.helpText, locale)}</p> : null}
      {showError ? <p id={`error-${path}`} role="alert" style={errorStyle} data-testid={`error-${path}`}>{firstError.message}</p> : null}
    </div>
  );
}

function ariaProps(field: NormalizedField, path: string, slice: { issues: unknown[]; required: boolean; disabled: boolean }) {
  return {
    id: `input-${path}`,
    'aria-required': slice.required || undefined,
    'aria-invalid': slice.issues.length > 0 || undefined,
    'aria-describedby': [slice.issues.length ? `error-${path}` : null, field.ui.helpText ? `help-${path}` : null, field.description ? `desc-${path}` : null].filter(Boolean).join(' ') || undefined,
    disabled: slice.disabled,
  } as const;
}

function HtmlField({ controller, field, path, locale }: FieldCtx & { field: NormalizedField; path: string }) {
  const slice = useField(controller, path);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const value = slice.value;
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    if (!controller.uploadProvider) { setUploadError('No upload provider registered.'); return; }
    setUploadError(null);
    const refs: UploadedAssetRef[] = [];
    try {
      for (const file of Array.from(files)) {
        setUploadProgress(0);
        const ref = await controller.uploadProvider.upload({
          asset: { id: `${file.name}-${file.size}`, name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, source: 'drag-drop' },
          constraints: { accept: field.validation.accept, maxSizeBytes: field.validation.maxSizeBytes },
          onProgress: setUploadProgress,
          auth: controller.auth,
        });
        refs.push(ref);
      }
      controller.setFieldValue(path, field.validation.multiple ? [...(Array.isArray(value) ? (value as UploadedAssetRef[]) : []), ...refs] : refs[0]);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploadProgress(null);
    }
  }, [controller, field, path, value]);
  if (!slice.visible || field.type === 'hidden') return null;
  const set = (v: unknown) => controller.setFieldValue(path, v);
  const common = ariaProps(field, path, slice);
  const strValue = value === null || value === undefined ? '' : String(value);

  let control: React.ReactNode;
  switch (field.type) {
    case 'textarea':
      control = <textarea {...common} style={{ ...inputStyle, minHeight: 24 * (field.ui.rows ?? 4) }} rows={field.ui.rows ?? 4} value={strValue} readOnly={slice.readonly} placeholder={field.ui.placeholder ? localize(field.ui.placeholder, locale) : undefined} onChange={(e) => set(e.target.value)} onFocus={() => controller.focus(path)} onBlur={() => controller.blur(path)} data-testid={`input-${path}`} />;
      break;
    case 'select': {
      const options = controller.getOptions(field.id);
      control = (
        <select {...common} style={inputStyle} value={strValue} onChange={(e) => set(e.target.value)} onFocus={() => controller.focus(path)} onBlur={() => controller.blur(path)} data-testid={`input-${path}`}>
          <option value="">{localize(field.ui.placeholder, locale) || 'Select…'}</option>
          {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{localize(o.label, locale)}</option>)}
        </select>
      );
      break;
    }
    case 'multiselect': {
      const options = controller.getOptions(field.id);
      const selected = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <select {...common} style={{ ...inputStyle, minHeight: 90 }} multiple value={selected} onChange={(e) => set(Array.from(e.target.selectedOptions).map((o) => o.value))} data-testid={`input-${path}`}>
          {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{localize(o.label, locale)}</option>)}
        </select>
      );
      break;
    }
    case 'radio': {
      const options = controller.getOptions(field.id);
      control = (
        <div role="radiogroup" aria-labelledby={`label-${path}`}>
          {options.map((o) => (
            <label key={String(o.value)} style={{ display: 'block', padding: '3px 0', fontWeight: 400 }}>
              <input type="radio" name={`radio-${path}`} value={String(o.value)} checked={value === o.value} disabled={slice.disabled} onChange={() => set(o.value)} data-testid={`radio-${path}-${String(o.value)}`} />
              {' '}{localize(o.label, locale)}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'checkbox': case 'switch': case 'consent':
      control = <input {...common} type="checkbox" role={field.type === 'switch' ? 'switch' : 'checkbox'} checked={value === true} disabled={slice.disabled || slice.readonly} onChange={(e) => set(e.target.checked)} data-testid={`input-${path}`} />;
      break;
    case 'rating': {
      const max = field.validation.max ?? 5;
      const num = typeof value === 'number' ? value : 0;
      control = (
        <div role="radiogroup" aria-label={localize(field.label, locale)}>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" onClick={() => !slice.readonly && set(n)} aria-label={`${n} of ${max}`} aria-pressed={n <= num} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: n <= num ? '#f5a623' : '#ccc' }} data-testid={`rating-${path}-${n}`}>★</button>
          ))}
        </div>
      );
      break;
    }
    case 'range':
      control = <input {...common} type="range" min={field.validation.min ?? 0} max={field.validation.max ?? 100} value={typeof value === 'number' ? value : field.validation.min ?? 0} onChange={(e) => set(Number(e.target.value))} data-testid={`input-${path}`} />;
      break;
    case 'file': case 'image': {
      const current = value as UploadedAssetRef | UploadedAssetRef[] | null;
      const names = current ? (Array.isArray(current) ? current.map((a) => a.name).join(', ') : current.name) : '';
      control = (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(e.dataTransfer.files); }}
          style={{ border: `2px dashed ${dragOver ? '#1f6feb' : '#bbb'}`, borderRadius: 8, padding: 14, background: dragOver ? '#eaf2ff' : '#fafafa' }}
          data-testid={`dropzone-${path}`}
        >
          <input ref={fileRef} {...common} type="file" accept={field.validation.accept?.join(',')} multiple={field.validation.multiple} style={{ display: 'none' }} onChange={(e) => e.target.files && void uploadFiles(e.target.files)} data-testid={`file-input-${path}`} />
          <button type="button" style={btnSecondary} onClick={() => fileRef.current?.click()} disabled={slice.disabled || slice.readonly || uploadProgress !== null} data-testid={`pick-${path}`}>
            {uploadProgress !== null ? `Uploading… ${Math.round(uploadProgress * 100)}%` : 'Choose file'}
          </button>
          <span style={{ marginLeft: 10, color: '#666', fontSize: 13 }}>or drag &amp; drop</span>
          {names ? <p style={helpStyle} data-testid={`asset-${path}`}>{names} ✓ uploaded</p> : null}
          {uploadError ? <p role="alert" style={errorStyle} data-testid={`upload-error-${path}`}>{uploadError}</p> : null}
        </div>
      );
      break;
    }
    case 'computed':
      control = <output id={`input-${path}`} style={{ ...inputStyle, background: '#f4f6f8', fontWeight: 600 }} data-testid={`computed-${path}`}>{value === null || value === undefined ? '—' : typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value)}</output>;
      break;
    case 'date':
      control = <input {...common} type="date" style={inputStyle} value={strValue} readOnly={slice.readonly} onChange={(e) => set(e.target.value)} onBlur={() => controller.blur(path)} data-testid={`input-${path}`} />;
      break;
    case 'time':
      control = <input {...common} type="time" style={inputStyle} value={strValue} readOnly={slice.readonly} onChange={(e) => set(e.target.value)} onBlur={() => controller.blur(path)} data-testid={`input-${path}`} />;
      break;
    case 'datetime':
      control = <input {...common} type="datetime-local" style={inputStyle} value={strValue} readOnly={slice.readonly} onChange={(e) => set(e.target.value)} onBlur={() => controller.blur(path)} data-testid={`input-${path}`} />;
      break;
    case 'color':
      control = <input {...common} type="color" style={{ ...inputStyle, height: 40, padding: 2 }} value={strValue || '#000000'} onChange={(e) => set(e.target.value)} data-testid={`input-${path}`} />;
      break;
    default: {
      const htmlType = field.type === 'email' ? 'email' : field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : field.type === 'phone' ? 'tel' : ['integer', 'decimal', 'currency', 'percentage', 'duration'].includes(field.type) ? 'number' : 'text';
      control = (
        <input {...common} type={htmlType} style={inputStyle} value={strValue} readOnly={slice.readonly}
          step={field.type === 'integer' ? 1 : field.validation.precision !== undefined ? 1 / 10 ** field.validation.precision : undefined}
          min={field.validation.min} max={field.validation.max}
          placeholder={field.ui.placeholder ? localize(field.ui.placeholder, locale) : undefined}
          autoComplete={field.type === 'email' ? 'email' : field.type === 'password' ? 'current-password' : undefined}
          onChange={(e) => set(htmlType === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
          onFocus={() => controller.focus(path)} onBlur={() => controller.blur(path)}
          data-testid={`input-${path}`} />
      );
    }
  }
  return <FieldWrap controller={controller} field={field} path={path} locale={locale}>{control}</FieldWrap>;
}

export function UniversalForm({ controller, locale, onSubmitted, submitLabel, className }: UniversalFormProps) {
  const snap = useFormSnapshot(controller);
  const loc = locale ?? controller.ir.localization.defaultLocale;
  const [stepIndex, setStepIndex] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fieldById = useMemo(() => new Map(controller.ir.fields.map((f) => [f.id, f])), [controller]);

  const renderField = (field: NormalizedField, path: string): React.ReactNode => {
    if (field.type === 'group') {
      const children = controller.ir.fields.filter((f) => f.parentId === field.id);
      return (
        <fieldset key={field.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 14 }} data-testid={`group-${field.id}`}>
          <legend style={{ fontWeight: 700, padding: '0 6px' }}>{localize(field.label, loc)}</legend>
          {children.map((c) => renderField(c, c.key))}
        </fieldset>
      );
    }
    if (field.type === 'repeater') {
      const rowIds = snap.repeaterRows[field.id] ?? [];
      const children = controller.ir.fields.filter((f) => f.parentId === field.id);
      const min = field.validation.minItems ?? 0;
      return (
        <fieldset key={field.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, marginBottom: 14 }} data-testid={`repeater-${field.id}`}>
          <legend style={{ fontWeight: 700, padding: '0 6px' }}>{localize(field.label, loc)}</legend>
          {rowIds.map((rowId, index) => (
            <div key={rowId} style={{ border: '1px solid #eee', borderRadius: 6, padding: 12, marginBottom: 10 }} data-testid={`row-${field.id}-${rowId}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <strong style={{ fontSize: 13, color: '#666' }}>Entry {index + 1}</strong>
                <span>
                  <button type="button" style={{ ...btnSecondary, padding: '2px 8px', marginRight: 4 }} disabled={index === 0} aria-label={`Move entry ${index + 1} up`} onClick={() => controller.moveRepeaterItem(field.id, index, index - 1)} data-testid={`move-up-${rowId}`}>↑</button>
                  <button type="button" style={{ ...btnSecondary, padding: '2px 8px', marginRight: 4 }} disabled={index === rowIds.length - 1} aria-label={`Move entry ${index + 1} down`} onClick={() => controller.moveRepeaterItem(field.id, index, index + 1)} data-testid={`move-down-${rowId}`}>↓</button>
                  <button type="button" style={{ ...btnSecondary, padding: '2px 8px', color: '#c0392b' }} disabled={rowIds.length <= min} aria-label={`Remove entry ${index + 1}`} onClick={() => controller.removeRepeaterItem(field.id, rowId)} data-testid={`remove-${rowId}`}>✕</button>
                </span>
              </div>
              {children.map((c) => renderField(c, c.key.replace(`${field.key}[]`, `${field.key}.${index}`)))}
            </div>
          ))}
          <button type="button" style={btnSecondary} onClick={() => controller.addRepeaterItem(field.id)} data-testid={`add-${field.id}`}>+ Add entry</button>
        </fieldset>
      );
    }
    return <HtmlField key={`${field.id}-${path}`} controller={controller} field={field} path={path} locale={loc} />;
  };

  const collectRefs = (node: LayoutNode | undefined): string[] =>
    node ? [...(node.fieldRefs ?? []), ...(node.children ?? []).flatMap(collectRefs)] : [];

  const renderLayout = (node: LayoutNode, key: string): React.ReactNode => {
    const title = node.title ? localize(node.title, loc) : undefined;
    const fields = (node.fieldRefs ?? []).map((id) => { const f = fieldById.get(id); return f ? renderField(f, f.key) : null; });
    if (node.type === 'steps') {
      const steps = (node.children ?? []).filter((c) => c.type === 'step' || c.type === 'summary');
      const current = steps[Math.min(stepIndex, steps.length - 1)];
      const isLast = stepIndex >= steps.length - 1;
      const stepIds = collectRefs(current);
      return (
        <div key={key} data-testid="wizard">
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }} aria-hidden="true">
            {steps.map((s, i) => <div key={s.id ?? i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= stepIndex ? '#1f6feb' : '#ddd' }} />)}
          </div>
          <h3 style={{ margin: '0 0 12px' }}>{title ? `${title} — ` : ''}{current?.title ? localize(current.title, loc) : `Step ${stepIndex + 1}`}</h3>
          {current?.type === 'summary' ? (
            <dl data-testid="summary">
              {controller.ir.fields.filter((f) => !f.parentId && !['group', 'repeater'].includes(f.type) && snap.visibility[f.id] !== false).map((f) => (
                <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #eee' }}>
                  <dt style={{ color: '#555' }}>{localize(f.label, loc)}</dt>
                  <dd style={{ margin: 0, fontWeight: 600 }}>{snap.values[f.key] === null || snap.values[f.key] === undefined ? '—' : String(snap.values[f.key])}</dd>
                </div>
              ))}
            </dl>
          ) : renderLayout(current ?? { type: 'group' }, `${key}-cur`)}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
            <button type="button" style={btnSecondary} disabled={stepIndex === 0} onClick={() => setStepIndex((i) => Math.max(0, i - 1))} data-testid="wizard-back">Back</button>
            {!isLast ? (
              <button type="button" style={btnStyle} disabled={advancing} onClick={async () => {
                if (advancing) return;
                setAdvancing(true);
                try {
                  for (const id of stepIds) { const f = fieldById.get(id); if (f) controller.blur(f.key); }
                  const result = await controller.validate();
                  const errs = result.issues.some((i) => {
                    const f = controller.ir.fields.find((x) => i.path === x.key || i.path.startsWith(`${x.key}.`));
                    return f && stepIds.includes(f.id) && i.severity === 'error';
                  });
                  if (!errs) setStepIndex((i) => i + 1);
                } finally { setAdvancing(false); }
              }} data-testid="wizard-next">Next</button>
            ) : null}
          </div>
        </div>
      );
    }
    if (node.type === 'divider') return <hr key={key} style={{ border: 'none', borderTop: '1px solid #e0e0e0', margin: '14px 0' }} />;
    if (node.type === 'text') return <p key={key} style={{ color: '#444' }}>{node.text ? localize(node.text, loc) : ''}</p>;
    if (node.type === 'repeater') { const f = node.repeaterRef ? fieldById.get(node.repeaterRef) : undefined; return f ? renderField(f, f.key) : null; }
    const isRow = node.type === 'row' || node.type === 'columns';
    return (
      <section key={key} style={{ marginBottom: 16 }} aria-label={title} data-testid={node.id ? `layout-${node.id}` : undefined}>
        {title ? <h3 style={{ margin: '0 0 10px' }}>{title}</h3> : null}
        <div style={isRow ? { display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, (node.fieldRefs?.length ?? 0) + (node.children?.length ?? 0))}, 1fr)`, gap: 12 } : undefined}>
          {fields}
          {(node.children ?? []).map((c, i) => renderLayout(c, `${key}-${i}`))}
        </div>
      </section>
    );
  };

  const errorIssues = snap.issues.filter((i) => i.severity === 'error');
  const showSummary = (snap.state === 'invalid' || snap.submission.status === 'failed') && errorIssues.length > 0;
  const result = snap.submission.result;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault(); // synchronous — prevents native navigation before any await
    setSubmitting(true);
    try {
      const result = await controller.submit();
      onSubmitted?.(result);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={className}
      noValidate
      onSubmit={(e) => { void handleSubmit(e); }}
      style={{ maxWidth: 640, margin: '0 auto', padding: 20, fontFamily: 'system-ui, sans-serif' }}
      data-testid="universal-form"
    >
      <h2 style={{ marginTop: 0 }}>{controller.ir.formId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</h2>
      {renderLayout(controller.ir.layout, 'root')}
      {showSummary ? (
        <div role="alert" style={{ background: '#fdecea', borderRadius: 8, padding: 12, marginBottom: 12 }} data-testid="error-summary">
          <strong style={{ color: '#c0392b' }}>{errorIssues.length} problem{errorIssues.length === 1 ? '' : 's'} to fix:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {errorIssues.slice(0, 8).map((i, idx) => <li key={idx} style={{ color: '#c0392b', fontSize: 13 }}>{i.message} <code>({i.path})</code></li>)}
          </ul>
        </div>
      ) : null}
      <div aria-live="polite">
        {result?.status === 'succeeded' ? <p style={{ color: '#1b5e20', fontWeight: 600, background: '#e8f5e9', padding: 12, borderRadius: 8 }} data-testid="submit-success">Submitted successfully.</p> : null}
        {result?.status === 'queued-offline' ? <p style={{ color: '#8d6e00', background: '#fff8e1', padding: 12, borderRadius: 8 }} data-testid="submit-queued">Saved offline — not yet submitted to the server.</p> : null}
        {result && !['succeeded', 'queued-offline', 'validation-failed'].includes(result.status) ? (
          <p role="alert" style={{ color: '#c0392b', background: '#fdecea', padding: 12, borderRadius: 8 }} data-testid="submit-error">
            Submission failed: {'message' in result ? result.message : result.status}{'code' in result ? ` (${result.code})` : ''}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        style={{ ...btnStyle, opacity: submitting || snap.state === 'submitting' ? 0.6 : 1 }}
        disabled={submitting || snap.state === 'submitting'}
        aria-busy={submitting || snap.state === 'submitting'}
        onClick={() => { void handleSubmit(); }}
        data-testid="submit-button"
      >
        {submitting || snap.state === 'submitting' ? 'Submitting…' : submitLabel ?? 'Submit'}
      </button>
    </form>
  );
}
