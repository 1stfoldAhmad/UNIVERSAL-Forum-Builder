/**
 * Shared submission/read security policy (TypeScript reference).
 * Python (vds_form.policy) and PHP (VdsForm\Policy) mirror these rules and the
 * shared fixtures in packages/form-conformance/fixtures/security-paths.json.
 */
import type {
  AuthContext, FormIR, FormValues, OperationInputDef, RbacEvaluator,
  SubmissionDef, ValidationIssue, ValueType,
} from '@vds-form/types';

export const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 64;
const MAX_NODES = 10000;
export const OPERATION_INPUT_LIMITS = {
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxStringLength: 10000,
  maxArrayLength: 1000,
  maxObjectKeys: 1000,
} as const;
const ASSET_KEYS = new Set(['id', 'name', 'mimeType', 'sizeBytes', 'source', 'localUri', 'assetRef', 'url']);

export interface PolicyIssue { code: string; message: string; path: string; fieldId?: string; severity: 'error'; source: 'schema' }

const issue = (code: string, message: string, path: string, fieldId?: string): PolicyIssue =>
  ({ code, message, path, fieldId, severity: 'error', source: 'schema' });

/** Split a concrete or template key path into normalized segments. Numeric
 * indices normalize to [] so items.0.secret matches items[].secret. */
export function pathSegments(path: string): string[] | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return undefined;
  const expanded = path.replace(/\[(\d*)\]/g, (_m, idx: string) => `.${idx === '' ? '[]' : idx}`);
  const parts = expanded.split('.');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '') return undefined;
    if (FORBIDDEN_SEGMENTS.has(part)) return undefined;
    out.push(/^\d+$/.test(part) ? '[]' : part);
  }
  return out;
}

export function normalizePath(path: string): string | undefined {
  const seg = pathSegments(path);
  if (!seg) return undefined;
  let out = '';
  for (const s of seg) out += s === '[]' ? '[]' : (out ? `.${s}` : s);
  return out;
}

export function isPathUnder(path: string, ancestor: string): boolean {
  const p = pathSegments(path); const a = pathSegments(ancestor);
  if (!p || !a || p.length < a.length) return false;
  return a.every((seg, i) => p[i] === seg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Remove every subtree matching a template path (or descendant of one).
 * Visible siblings and array indices are preserved. Unsafe keys are dropped. */
export function stripPaths(values: unknown, templates: string[]): unknown {
  const normalized = templates.map(normalizePath).filter((x): x is string => Boolean(x));
  const walk = (value: unknown, segments: string[], depth: number): unknown => {
    if (depth > MAX_DEPTH) return undefined;
    const norm = segments.join('.');
    if (normalized.some((t) => isPathUnder(norm, t))) return undefined;
    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, [...segments, String(i)], depth + 1)).filter((v) => v !== undefined);
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_SEGMENTS.has(k)) continue;
        const cleaned = walk(v, [...segments, k], depth + 1);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    }
    return value;
  };
  return walk(values, [], 0);
}

export function hiddenTemplatePaths(ir: FormIR, visibility: Record<string, boolean>, includeHidden = false): string[] {
  if (includeHidden) return [];
  return ir.fields.filter((f) => visibility[f.id] === false).map((f) => f.key);
}

function templateSet(ir: FormIR): Set<string> {
  const set = new Set<string>();
  for (const f of ir.fields) {
    const n = normalizePath(f.key);
    if (n) set.add(n);
  }
  return set;
}

function nearestField(ir: FormIR, normPath: string): FormIR['fields'][number] | undefined {
  let best: FormIR['fields'][number] | undefined;
  let bestLen = -1;
  for (const f of ir.fields) {
    const n = normalizePath(f.key);
    if (n && isPathUnder(normPath, n)) {
      const len = pathSegments(n)!.length;
      if (len > bestLen) { best = f; bestLen = len; }
    }
  }
  return best;
}

function allowedByFields(ir: FormIR, templates: Set<string>, normPath: string): boolean {
  if (templates.has(normPath)) return true;
  for (const t of templates) if (isPathUnder(t, normPath)) return true; // ancestor container
  const field = nearestField(ir, normPath);
  if (!field) return false;
  const fieldNorm = normalizePath(field.key)!;
  const fieldSeg = pathSegments(fieldNorm)!;
  const pathSeg = pathSegments(normPath)!;
  const rest = pathSeg.slice(fieldSeg.length);
  if (rest.length === 0) return true;
  const vt: ValueType = field.valueType;
  if (vt === 'asset' || vt === 'asset[]') {
    // asset[] elements normalize to []; allow exactly one known asset property.
    const props = rest.filter((s) => s !== '[]');
    return props.length === 1 && ASSET_KEYS.has(props[0]) && rest.length <= (vt === 'asset[]' ? 2 : 1);
  }
  if (vt === 'string[]' || vt === 'number[]') return rest.every((s) => s === '[]');
  return false;
}

/** Reject undeclared properties in field-keyed values. Operation inputs are
 * validated separately against their typed contract. */
export function collectUnknownPropertyIssues(ir: FormIR, values: FormValues, operationInputs?: Record<string, OperationInputDef>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const templates = templateSet(ir);
  const opRoots = new Set(Object.keys(operationInputs ?? {}));
  let nodes = 0;
  const walk = (value: unknown, segments: string[], depth: number): void => {
    if (depth > MAX_DEPTH) { issues.push(issue('PAYLOAD_TOO_DEEP', 'Payload nesting exceeds the security budget.', segments.join('.'))); return; }
    if (++nodes > MAX_NODES) { issues.push(issue('PAYLOAD_TOO_LARGE', 'Payload exceeds the security node budget.', segments.join('.'))); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, [...segments, String(i)], depth + 1)); return; }
    if (!isPlainObject(value)) return;
    for (const [k, v] of Object.entries(value)) {
      const child = [...segments, k];
      const concrete = child.join('.');
      if (FORBIDDEN_SEGMENTS.has(k)) { issues.push(issue('UNSAFE_PROPERTY', 'Prototype-pollution property rejected.', concrete)); continue; }
      const norm = normalizePath(concrete);
      if (!norm) { issues.push(issue('UNKNOWN_PROPERTY', 'Property path is not declared.', concrete)); continue; }
      if (segments.length === 0 && opRoots.has(k)) continue; // typed operation input
      if (!allowedByFields(ir, templates, norm)) issues.push(issue('UNKNOWN_PROPERTY', 'Property is not a declared form field.', concrete));
      walk(v, child, depth + 1);
    }
  };
  walk(values, [], 0);
  return issues;
}

function typeMatchesPolicy(value: unknown, vt: ValueType): boolean {
  switch (vt) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'number[]': return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v));
    case 'object': case 'asset': return isPlainObject(value);
    case 'object[]': return Array.isArray(value) && value.every(isPlainObject);
    case 'asset[]': return Array.isArray(value);
    case 'null': return value === null;
    default: return false;
  }
}

export function validateOperationInputs(defs: Record<string, OperationInputDef> | undefined, values: FormValues): { values: FormValues; issues: ValidationIssue[] } {
  const out: FormValues = {}; const issues: ValidationIssue[] = [];
  if (!defs) return { values: out, issues };
  let nodes = 0;
  const L = OPERATION_INPUT_LIMITS;
  // `def === undefined` walks additionalProperties / untyped array elements:
  // resource limits and forbidden names still apply at every depth.
  const check = (def: OperationInputDef | undefined, value: unknown, path: string, depth: number): unknown => {
    if (depth > L.maxDepth) { issues.push(issue('OPERATION_INPUT_TOO_DEEP', 'Operation input exceeds maximum nesting depth.', path)); return undefined; }
    if (++nodes > L.maxNodes) { issues.push(issue('OPERATION_INPUT_TOO_MANY_NODES', 'Operation input exceeds maximum node count.', path)); return undefined; }
    if (value === undefined || value === null) {
      if (def?.required) issues.push(issue('OPERATION_INPUT_REQUIRED', 'Required operation input is missing.', path));
      return undefined;
    }
    if (typeof value === 'string' && value.length > L.maxStringLength) { issues.push(issue('OPERATION_INPUT_STRING_TOO_LARGE', 'Operation input string exceeds maximum length.', path)); return undefined; }
    if (def && !typeMatchesPolicy(value, def.valueType)) { issues.push(issue('OPERATION_INPUT_TYPE_INVALID', `Expected ${def.valueType}.`, path)); return undefined; }
    if (Array.isArray(value)) {
      if (value.length > L.maxArrayLength) { issues.push(issue('OPERATION_INPUT_ARRAY_TOO_LARGE', 'Operation input array exceeds maximum length.', path)); return undefined; }
      return value.map((item, i) => check(def?.items, item, `${path}.${i}`, depth + 1)).filter((v) => v !== undefined);
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length > L.maxObjectKeys) { issues.push(issue('OPERATION_INPUT_OBJECT_TOO_LARGE', 'Operation input object exceeds maximum property count.', path)); return undefined; }
      const obj: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        if (FORBIDDEN_SEGMENTS.has(k)) { issues.push(issue('UNSAFE_PROPERTY', 'Prototype-pollution property rejected.', `${path}.${k}`)); continue; }
        const childDef = def?.properties?.[k];
        if (!childDef && def && !def.additionalProperties) { issues.push(issue('UNKNOWN_PROPERTY', 'Operation input property is not declared.', `${path}.${k}`)); continue; }
        const cleaned = check(childDef, v, `${path}.${k}`, depth + 1);
        if (cleaned !== undefined) obj[k] = cleaned;
      }
      return obj;
    }
    return value;
  };
  for (const [name, def] of Object.entries(defs)) {
    if (FORBIDDEN_SEGMENTS.has(name)) { issues.push(issue('UNSAFE_PROPERTY', 'Operation input name rejected.', name)); continue; }
    const cleaned = check(def, values[name], name, 0);
    if (cleaned !== undefined) out[name] = cleaned as never;
  }
  return { values: out, issues };
}

export interface ReadPolicy { denied: Set<string>; unresolved: string[]; issues: PolicyIssue[] }

/** Field-level READ authorization. Fail closed when permissions are declared
 * but auth/evaluator is missing or evaluation fails. Visibility/disabled/readonly
 * are never consulted here. */
export function computeReadPolicy(ir: FormIR, auth: AuthContext | undefined, rbac: RbacEvaluator | undefined): ReadPolicy {
  const denied = new Set<string>(); const unresolved: string[] = []; const issues: PolicyIssue[] = [];
  const access = ir.security?.fieldAccess ?? {};
  for (const [fieldId, def] of Object.entries(access)) {
    const perms = def.read ?? [];
    if (perms.length === 0) continue;
    const field = ir.fields.find((f) => f.id === fieldId);
    const path = field?.key ?? fieldId;
    if (!rbac || !auth) {
      denied.add(fieldId); unresolved.push(fieldId);
      issues.push(issue('FIELD_READ_UNRESOLVED', 'Read authorization cannot be resolved; field is hidden.', path, fieldId));
      continue;
    }
    try {
      const d = rbac.evaluate(auth, perms);
      if (!d.allowed) { denied.add(fieldId); issues.push(issue('FIELD_READ_DENIED', d.missing.length ? `Missing read permissions: ${d.missing.join(', ')}` : 'Read permission denied.', path, fieldId)); }
    } catch (err) {
      denied.add(fieldId); unresolved.push(fieldId);
      issues.push(issue('FIELD_READ_UNRESOLVED', `Read evaluator failed: ${err instanceof Error ? err.message : String(err)}`, path, fieldId));
    }
  }
  return { denied, unresolved, issues };
}

export function readableTemplates(ir: FormIR, denied: Set<string>): string[] {
  return ir.fields.filter((f) => denied.has(f.id)).map((f) => f.key);
}

export function filterReadableValues(ir: FormIR, values: FormValues, denied: Set<string>): FormValues {
  if (denied.size === 0) return values;
  return (stripPaths(values, readableTemplates(ir, denied)) ?? {}) as FormValues;
}

/** Prepare a trusted-server request: strict root policy, mapping reconstruction,
 * hidden stripping, unknown-property rejection, typed operation inputs. */
export function prepareSubmissionValues(ir: FormIR, requestValues: FormValues, visibility: Record<string, boolean>): { fieldValues: FormValues; operationInputs: FormValues; issues: ValidationIssue[] } {
  const submission: SubmissionDef | undefined = ir.submission;
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(requestValues)) return { fieldValues: {}, operationInputs: {}, issues: [issue('PAYLOAD_INVALID', 'Submission values must be an object.', '')] };
  const opDefs = submission?.operationInputs;
  const opRoots = new Set(Object.keys(opDefs ?? {}));
  const mapping = submission?.inputMapping;
  const allowedRoots = mapping ? new Set(Object.keys(mapping)) : new Set(ir.fields.filter((f) => !f.parentId).map((f) => f.key.split('.')[0].replace('[]', '')));
  let fieldValues: FormValues = {};
  const opRaw: FormValues = {};
  for (const [k, v] of Object.entries(requestValues)) {
    if (FORBIDDEN_SEGMENTS.has(k)) { issues.push(issue('UNSAFE_PROPERTY', 'Prototype-pollution property rejected.', k)); continue; }
    if (opRoots.has(k)) { opRaw[k] = v; continue; }
    if (!allowedRoots.has(k)) { issues.push(issue('UNKNOWN_PROPERTY', 'Submission property is not declared.', k)); continue; }
    if (mapping) {
      const sourcePath = mapping[k];
      const norm = normalizePath(sourcePath);
      if (!norm) { issues.push(issue('INPUT_MAPPING_INVALID', 'Input mapping source path is invalid.', k)); continue; }
      // setIn is prototype-safe; build a field-keyed object from the mapped param.
      const parts = sourcePath.replace(/\[(\d*)\]/g, (_m, idx: string) => `.${idx === '' ? '[]' : idx}`).split('.').filter(Boolean);
      let cursor: Record<string, unknown> = fieldValues;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (FORBIDDEN_SEGMENTS.has(p)) { cursor = {}; break; }
        if (!isPlainObject(cursor[p])) cursor[p] = {};
        cursor = cursor[p] as Record<string, unknown>;
      }
      const last = parts[parts.length - 1];
      if (last && !FORBIDDEN_SEGMENTS.has(last)) cursor[last] = v;
    } else fieldValues[k] = v;
  }
  const hidden = hiddenTemplatePaths(ir, visibility, submission?.includeHidden);
  fieldValues = (stripPaths(fieldValues, hidden) ?? {}) as FormValues;
  issues.push(...collectUnknownPropertyIssues(ir, fieldValues, opDefs));
  const op = validateOperationInputs(opDefs, opRaw);
  issues.push(...op.issues);
  return { fieldValues, operationInputs: op.values, issues };
}
