/**
 * @vds-form/validation — shared validation semantics (sync rules + async contract).
 * Used identically by the headless runtime and trusted server execution adapters.
 */
import type {
  AsyncValidationRule, DataSourceProvider, FormIR, LocalizedText, NormalizedField,
  ValidationIssue, ValidationResult,
} from '@vds-form/types';
import { evaluateBoolean, getPath, type EvalScope } from '@vds-form/expressions';
import { defaultFieldRegistry, type FieldRegistry } from '@vds-form/fields';

export * from './policy';

export interface EffectiveFieldState {
  visibility: Record<string, boolean>;
  required: Record<string, boolean>;
  disabled: Record<string, boolean>;
  readonly: Record<string, boolean>;
}

export interface ValidateOptions {
  locale?: string;
  /** 'change' validates eagerly; 'submit' additionally rejects un-uploaded local assets. */
  phase?: 'change' | 'submit';
  /** Restrict validation to concrete paths (prefix match). */
  paths?: string[];
  context?: Record<string, unknown>;
  sources?: Record<string, unknown>;
  fields?: FieldRegistry;
}

export function localize(text: LocalizedText | undefined, locale: string, fallback = 'en'): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text[fallback] ?? Object.values(text)[0] ?? '';
}

const FORMAT_PATTERNS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  url: /^https?:\/\/[^\s/$.?#].[^\s]*$/i,
  phone: /^\+?[0-9\s\-().]{6,20}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'postal-code': /^[A-Za-z0-9][A-Za-z0-9\s-]{2,11}$/,
  color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i,
  barcode: /^[A-Za-z0-9-]{4,64}$/,
};

/** MIME accept matching shared by runtime/server validation. */
export function assetTypeAllowed(acceptList: string[] | undefined, fileName: string | undefined, mimeType: string | undefined): boolean {
  if (!acceptList?.length) return true;
  const rawMime = (mimeType ?? '').trim().toLowerCase().split(';', 1)[0];
  const mime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
  const extension = fileName?.match(/\.[^./]+$/)?.[0]?.toLowerCase();
  return acceptList.some((raw) => {
    const accept = raw.trim().toLowerCase();
    if (accept.startsWith('.')) return !!extension && extension === accept;
    const normalizedAccept = accept === 'image/jpg' ? 'image/jpeg' : accept;
    return normalizedAccept === mime || (normalizedAccept.endsWith('/*') && mime.startsWith(normalizedAccept.slice(0, -1)));
  });
}

/** Heuristic ReDoS guard: reject nested quantifiers and oversized patterns. */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > 1000) return false;
  if (/(\+|\*|\{)\s*(\)|\])?\s*(\+|\*|\{[0-9,]+\})/.test(pattern)) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function typeMatches(value: unknown, valueType: string): boolean {
  switch (valueType) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'number[]': return Array.isArray(value) && value.every((v) => typeof v === 'number');
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'object[]': return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v));
    case 'asset': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'asset[]': return Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

interface FieldInstance { field: NormalizedField; concreteKey: string; rowScope?: { rowPrefix: string; rowIndex: number; parentPrefix: string } }

/** Expand template fields into concrete instances (repeater rows). */
export function expandFieldInstances(ir: FormIR, values: Record<string, unknown>): FieldInstance[] {
  const out: FieldInstance[] = [];
  const repeaters = ir.fields.filter((f) => f.type === 'repeater');
  const rowKey = (template: string, repeaterKey: string, index: number) =>
    template.replace(`${repeaterKey}[]`, `${repeaterKey}.${index}`);
  for (const f of ir.fields) {
    if (f.type === 'repeater' || f.type === 'group') {
      out.push({ field: f, concreteKey: f.key });
    }
    if (!f.repeaterId) {
      if (f.type !== 'repeater' && f.type !== 'group') out.push({ field: f, concreteKey: f.key });
      continue;
    }
    const repeater = repeaters.find((r) => r.id === f.repeaterId);
    if (!repeater) continue;
    const rows = getPath(values, repeater.key);
    const count = Array.isArray(rows) ? rows.length : 0;
    for (let i = 0; i < count; i++) {
      out.push({
        field: f,
        concreteKey: rowKey(f.key, repeater.key, i),
        rowScope: { rowPrefix: `${repeater.key}.${i}`, rowIndex: i, parentPrefix: '' },
      });
    }
  }
  return out;
}

function issue(code: string, message: string, path: string, fieldId: string | undefined, source: ValidationIssue['source'] = 'field', severity: ValidationIssue['severity'] = 'error'): ValidationIssue {
  return { code, message, path, fieldId, severity, source };
}

function validateOne(
  inst: FieldInstance, values: Record<string, unknown>, state: EffectiveFieldState,
  opts: ValidateOptions, registry: FieldRegistry, locale: string,
): ValidationIssue[] {
  const { field, concreteKey } = inst;
  const issues: ValidationIssue[] = [];
  if (state.visibility[field.id] === false) return issues;
  if (field.type === 'group' || field.type === 'repeater') {
    if (field.type === 'repeater') {
      const rows = getPath(values, field.key);
      const count = Array.isArray(rows) ? rows.length : 0;
      const min = field.validation.minItems;
      if (state.required[field.id] && count === 0) issues.push(issue('REQUIRED', 'At least one entry is required.', concreteKey, field.id));
      if (typeof min === 'number' && count < min) issues.push(issue('MIN_ITEMS', `At least ${min} entries required.`, concreteKey, field.id));
      const max = field.validation.maxItems;
      if (typeof max === 'number' && count > max) issues.push(issue('MAX_ITEMS', `At most ${max} entries allowed.`, concreteKey, field.id));
    }
    return issues;
  }
  const value = getPath(values, concreteKey);
  const contract = registry.get(field.type);
  const required = state.required[field.id] ?? field.required;
  const disabled = state.disabled[field.id] ?? field.disabled;

  if (required && !disabled) {
    if (contract?.requiredMode === 'must-be-true') {
      if (value !== true) issues.push(issue('REQUIRED', localize(field.validation.message, locale) || 'This consent is required.', concreteKey, field.id));
    } else if (isEmptyValue(value)) {
      issues.push(issue('REQUIRED', localize(field.validation.message, locale) || 'This field is required.', concreteKey, field.id));
    }
  }
  if (isEmptyValue(value)) return issues;

  if (!typeMatches(value, field.valueType)) {
    issues.push(issue('TYPE_INVALID', `Expected ${field.valueType}.`, concreteKey, field.id));
    return issues;
  }
  const v = field.validation;
  if (typeof value === 'string') {
    if (v.minLength !== undefined && value.length < v.minLength) issues.push(issue('MIN_LENGTH', `Must be at least ${v.minLength} characters.`, concreteKey, field.id));
    if (v.maxLength !== undefined && value.length > v.maxLength) issues.push(issue('MAX_LENGTH', `Must be at most ${v.maxLength} characters.`, concreteKey, field.id));
    if (v.format) {
      const re = FORMAT_PATTERNS[v.format];
      if (re && !re.test(value)) issues.push(issue('FORMAT_INVALID', `Invalid ${v.format} format.`, concreteKey, field.id));
      if (v.format === 'date' && re?.test(value)) {
        const [y, m, d] = value.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
          issues.push(issue('FORMAT_INVALID', 'Invalid calendar date.', concreteKey, field.id));
        }
      }
    }
    if (v.pattern) {
      if (!isSafePattern(v.pattern)) issues.push(issue('PATTERN_UNSAFE', 'Validation pattern rejected as unsafe.', concreteKey, field.id));
      else if (value.length <= 10000 && !new RegExp(v.pattern).test(value)) issues.push(issue('PATTERN_MISMATCH', localize(v.message, locale) || 'Value does not match the required pattern.', concreteKey, field.id));
    }
  }
  if (typeof value === 'number') {
    if (v.min !== undefined && value < v.min) issues.push(issue('MIN_VALUE', `Must be ≥ ${v.min}.`, concreteKey, field.id));
    if (v.max !== undefined && value > v.max) issues.push(issue('MAX_VALUE', `Must be ≤ ${v.max}.`, concreteKey, field.id));
    if (v.precision !== undefined) {
      const scaled = value * 10 ** v.precision;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-9) issues.push(issue('PRECISION_EXCEEDED', `At most ${v.precision} decimal places allowed.`, concreteKey, field.id));
    }
  }
  if (Array.isArray(value)) {
    if (v.minItems !== undefined && value.length < v.minItems) issues.push(issue('MIN_ITEMS', `Select at least ${v.minItems}.`, concreteKey, field.id));
    if (v.maxItems !== undefined && value.length > v.maxItems) issues.push(issue('MAX_ITEMS', `Select at most ${v.maxItems}.`, concreteKey, field.id));
  }
  if (field.valueType === 'asset' || field.valueType === 'asset[]') {
    const assets = Array.isArray(value) ? value : [value];
    if (!v.multiple && Array.isArray(value) && value.length > 1) issues.push(issue('MULTIPLE_NOT_ALLOWED', 'Only one file is allowed.', concreteKey, field.id));
    for (const a of assets) {
      const asset = a as { name?: string; mimeType?: string; sizeBytes?: number; assetRef?: string; localUri?: string };
      if (!assetTypeAllowed(v.accept, asset.name, asset.mimeType)) {
        issues.push(issue('ASSET_TYPE_REJECTED', `File type ${asset.mimeType ?? 'unknown'} is not allowed.`, concreteKey, field.id));
      }
      if (v.maxSizeBytes !== undefined && typeof asset.sizeBytes === 'number' && asset.sizeBytes > v.maxSizeBytes) {
        issues.push(issue('ASSET_TOO_LARGE', `File exceeds ${v.maxSizeBytes} bytes.`, concreteKey, field.id));
      }
      if (opts.phase === 'submit' && !asset.assetRef) {
        issues.push(issue('ASSET_NOT_UPLOADED', 'File must be uploaded before submitting.', concreteKey, field.id));
      }
    }
  }
  return issues;
}

/** Full synchronous validation of concrete values against a compiled form. */
export function validateValues(
  ir: FormIR, values: Record<string, unknown>, state: EffectiveFieldState, opts: ValidateOptions = {},
): ValidationResult {
  const locale = opts.locale ?? ir.localization.defaultLocale;
  const registry = opts.fields ?? defaultFieldRegistry;
  const issues: ValidationIssue[] = [];
  const instances = expandFieldInstances(ir, values);
  const scoped = opts.paths?.length
    ? instances.filter((inst) => opts.paths!.some((p) => inst.concreteKey === p || inst.concreteKey.startsWith(`${p}.`) || p.startsWith(`${inst.concreteKey}.`)))
    : instances;
  for (const inst of scoped) issues.push(...validateOne(inst, values, state, opts, registry, locale));

  // Cross-field rules (skip when restricted to paths that don't intersect reads).
  for (const rule of ir.crossFieldRules) {
    const scope: EvalScope = { values, context: opts.context, sources: opts.sources };
    const r = evaluateBoolean(rule.expr, scope);
    if (!r.ok) {
      issues.push(issue('RULE_EVALUATION_FAILED', `${rule.id}: ${r.message}`, rule.path ?? '', undefined, 'cross'));
    } else if (r.value === false) {
      issues.push(issue('CROSS_FIELD', localize(rule.message, locale), rule.path ?? '', undefined, 'cross', rule.severity));
    }
  }
  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

/**
 * Compute effective field state (visibility/required/disabled/readonly) from
 * base declarations + conditions. Shared by the headless runtime AND trusted
 * server adapters so client and server enforce identical semantics.
 */
export function computeEffectiveState(
  ir: FormIR, values: Record<string, unknown>,
  context?: Record<string, unknown>, sources?: Record<string, unknown>,
): { state: EffectiveFieldState; errors: Array<{ id: string; message: string }> } {
  const state: EffectiveFieldState = { visibility: {}, required: {}, disabled: {}, readonly: {} };
  for (const f of ir.fields) {
    state.visibility[f.id] = !f.hidden;
    state.required[f.id] = f.required;
    state.disabled[f.id] = f.disabled;
    state.readonly[f.id] = f.readonly;
  }
  const errors: Array<{ id: string; message: string }> = [];
  for (const c of ir.conditions) {
    const r = evaluateBoolean(c.when, { values, context, sources });
    if (!r.ok) { errors.push({ id: c.id, message: r.message }); continue; }
    if (r.value === true) {
      for (const eff of c.effects) {
        if (eff.set.visible !== undefined) state.visibility[eff.fieldId] = eff.set.visible;
        if (eff.set.required !== undefined) state.required[eff.fieldId] = eff.set.required;
        if (eff.set.disabled !== undefined) state.disabled[eff.fieldId] = eff.set.disabled;
        if (eff.set.readonly !== undefined) state.readonly[eff.fieldId] = eff.set.readonly;
      }
    }
  }
  return { state, errors };
}

/* ------------------------------------------------------------------ */
/* Async validation (registered operations only, cancel/stale-safe)    */
/* ------------------------------------------------------------------ */

export interface AsyncCheckOutcome { ruleId: string; path: string; valid: boolean; message?: string; code?: string }

export class AsyncValidator {
  private generations = new Map<string, number>();
  private controllers = new Map<string, AbortController>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private rules: AsyncValidationRule[],
    private resolveProvider: (operationRef: string) => DataSourceProvider | undefined,
    private locale: string,
  ) {}

  /** Schedule a debounced check; stale results can never overwrite newer ones. */
  schedule(
    rule: AsyncValidationRule, value: unknown,
    onResult: (outcome: AsyncCheckOutcome) => void,
    onStatus?: (status: 'pending' | 'validating' | 'idle') => void,
  ): void {
    this.cancel(rule.id);
    const gen = (this.generations.get(rule.id) ?? 0) + 1;
    this.generations.set(rule.id, gen);
    if (isEmptyValue(value)) { onStatus?.('idle'); return; }
    onStatus?.('pending');
    const debounce = rule.debounceMs ?? 250;
    this.timers.set(rule.id, setTimeout(() => { void this.run(rule, value, gen, onResult, onStatus); }, debounce));
  }

  private async run(
    rule: AsyncValidationRule, value: unknown, gen: number,
    onResult: (outcome: AsyncCheckOutcome) => void,
    onStatus?: (status: 'pending' | 'validating' | 'idle') => void,
  ): Promise<void> {
    const provider = this.resolveProvider(rule.operationRef);
    if (!provider) {
      if (this.generations.get(rule.id) === gen) onResult({ ruleId: rule.id, path: rule.path, valid: false, code: 'ASYNC_PROVIDER_NOT_REGISTERED', message: `No provider registered for ${rule.operationRef}.` });
      return;
    }
    const controller = new AbortController();
    this.controllers.set(rule.id, controller);
    onStatus?.('validating');
    const timeout = setTimeout(() => controller.abort(), rule.timeoutMs ?? 5000);
    try {
      const params: Record<string, unknown> = { value };
      if (rule.inputMapping) {
        for (const [k, v] of Object.entries(rule.inputMapping)) params[k] = v === '$value' ? value : v;
      }
      const res = await provider.query({ providerRef: rule.operationRef, params, signal: controller.signal });
      if (this.generations.get(rule.id) !== gen || controller.signal.aborted) return; // stale
      const first = res.items[0] as { valid?: boolean; message?: string } | undefined;
      const valid = first?.valid !== false;
      onResult({ ruleId: rule.id, path: rule.path, valid, message: valid ? undefined : (first?.message ?? localize(rule.message, this.locale)) });
    } catch (e) {
      if (this.generations.get(rule.id) !== gen) return;
      const aborted = controller.signal.aborted;
      onResult({ ruleId: rule.id, path: rule.path, valid: false, code: aborted ? 'ASYNC_TIMEOUT' : 'ASYNC_NETWORK_ERROR', message: aborted ? 'Validation timed out.' : `Validation failed: ${(e as Error).message}` });
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(rule.id);
      if (this.generations.get(rule.id) === gen) onStatus?.('idle');
    }
  }

  cancel(ruleId: string): void {
    const t = this.timers.get(ruleId);
    if (t) clearTimeout(t);
    this.timers.delete(ruleId);
    this.controllers.get(ruleId)?.abort();
    this.controllers.delete(ruleId);
  }

  /** Await all in-flight checks (used before submit). */
  async settle(): Promise<void> {
    // Give pending timers a chance to fire, then wait for controllers to finish.
    await new Promise((r) => setTimeout(r, 0));
    const deadline = Date.now() + 10000;
    while (this.controllers.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id);
    this.generations.clear();
  }
}
