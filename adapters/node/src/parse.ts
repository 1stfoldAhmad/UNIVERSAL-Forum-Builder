/** Parse no-JS form POST bodies (dot-path names) into typed FormValues. */
import type { FormIR, FormValues } from '@vds-form/types';
import { expandFieldInstances } from '@vds-form/validation';
import { setIn } from '@vds-form/expressions';

export type RawBody = Record<string, string | string[]>;

export function parseUrlEncoded(body: string): RawBody {
  const out: RawBody = {};
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const v = decodeURIComponent((eq < 0 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' '));
    if (k in out) { const cur = out[k]; out[k] = Array.isArray(cur) ? [...cur, v] : [cur as string, v]; }
    else out[k] = v;
  }
  return out;
}

/** Build nested values from dot-path names; numeric segments become array indices. */
export function parseFormValues(ir: FormIR, raw: RawBody, opts: { csrfParam?: string } = {}): FormValues {
  let values: FormValues = {};
  const instances = expandFieldInstances(ir, rawToSkeleton(ir, raw));
  const byPath = new Map(instances.map((i) => [i.concreteKey, i.field]));
  for (const [name, value] of Object.entries(raw)) {
    if (name === (opts.csrfParam ?? '_csrf') || name.startsWith('_')) continue;
    const field = byPath.get(name);
    const coerced = coerce(field?.valueType, field?.type, value);
    values = setIn(values, name, coerced) as FormValues;
  }
  // Boolean fields absent from the body are false (unchecked checkboxes).
  for (const inst of instances) {
    const f = inst.field;
    if ((f.type === 'checkbox' || f.type === 'switch' || f.type === 'consent') && !(inst.concreteKey in raw)) {
      values = setIn(values, inst.concreteKey, false) as FormValues;
    }
  }
  return values;
}

function rawToSkeleton(ir: FormIR, raw: RawBody): FormValues {
  // Discover repeater row indices present in the body so instances expand.
  let skeleton: FormValues = {};
  for (const name of Object.keys(raw)) {
    const parts = name.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (/^\d+$/.test(parts[i])) {
        const prefix = parts.slice(0, i + 1).join('.');
        skeleton = setIn(skeleton, prefix, {}) as FormValues;
      }
    }
  }
  // Ensure repeater keys exist as arrays sized to the max index seen.
  for (const f of ir.fields.filter((x) => x.type === 'repeater')) {
    let max = -1;
    for (const name of Object.keys(raw)) {
      if (name.startsWith(`${f.key}.`)) {
        const idx = Number(name.slice(f.key.length + 1).split('.')[0]);
        if (Number.isInteger(idx) && idx > max) max = idx;
      }
    }
    if (max >= 0) skeleton = setIn(skeleton, f.key, Array.from({ length: max + 1 }, () => ({}))) as FormValues;
  }
  return skeleton;
}

function coerce(valueType: string | undefined, type: string | undefined, value: string | string[]): unknown {
  if (Array.isArray(value)) {
    if (valueType === 'number[]') return value.map((v) => (v === '' ? null : Number(v)));
    return value;
  }
  if (type === 'checkbox' || type === 'switch' || type === 'consent') return value === 'true' || value === 'on' || value === '1';
  if (value === '') return null;
  if (valueType === 'integer') { const n = parseInt(value, 10); return Number.isNaN(n) ? value : n; }
  if (valueType === 'number') { const n = Number(value); return Number.isNaN(n) ? value : n; }
  if (valueType === 'boolean') return value === 'true' || value === 'on' || value === '1';
  return value;
}
