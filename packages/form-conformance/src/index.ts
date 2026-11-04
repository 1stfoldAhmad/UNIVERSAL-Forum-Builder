/**
 * @vds-form/conformance — shared, language-agnostic conformance fixtures + a
 * reference runner for the TypeScript implementation.
 *
 * The fixtures (fixtures/expressions.json, fixtures/forms.json) are the single
 * source of truth that EVERY execution adapter (TypeScript, Django, Laravel)
 * must satisfy. They are plain JSON data so non-TS adapters can load and run
 * them against their own engines. This module runs them against the TS core
 * and reports per-case pass/fail with expected vs actual.
 */
import { evaluate, deepEqual, type EvalScope } from '@vds-form/expressions';
import type { Expr } from '@vds-form/types';
import { compileForm } from '@vds-form/compiler';
import {
  collectUnknownPropertyIssues, computeReadPolicy, filterReadableValues,
  hiddenTemplatePaths, stripPaths, computeEffectiveState, validateValues, validateOperationInputs,
} from '@vds-form/validation';
import { buildSubmissionPayload } from '@vds-form/submission';
import type { FormDocument, OperationInputDef } from '@vds-form/types';
import expressionFixtures from '../fixtures/expressions.json';
import formFixtures from '../fixtures/forms.json';
import securityFixtures from '../fixtures/security-paths.json';
import operationLimitFixtures from '../fixtures/operation-limits.json';

export const EXPRESSION_FIXTURES = expressionFixtures;
export const FORM_FIXTURES = formFixtures;
export const SECURITY_FIXTURES = securityFixtures;
export const OPERATION_LIMIT_FIXTURES = operationLimitFixtures;
export const CONFORMANCE_SPEC_VERSION = '1.0.0';

export interface CaseResult {
  suite: string;
  id: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
}

export interface ConformanceReport {
  specVersion: string;
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
}

interface ExpressionCase {
  id: string;
  expr: Expr;
  scope: EvalScope;
  expect: { ok: true; value: unknown } | { ok: false; code: string };
}

/** Run the vds.expr/1 expression suite against the TS evaluator. */
export function runExpressionConformance(): CaseResult[] {
  return (expressionFixtures.cases as ExpressionCase[]).map((c) => {
    const actual = evaluate(c.expr, c.scope);
    let passed: boolean;
    if (c.expect.ok) {
      passed = actual.ok === true && deepEqual(actual.value, c.expect.value);
    } else {
      passed = actual.ok === false && actual.code === c.expect.code;
    }
    return { suite: 'vds.expr/1', id: c.id, passed, expected: c.expect, actual };
  });
}

interface CompilationCase { id: string; document: FormDocument; expectOk: boolean; codes?: string[] }
interface ValidationCase { id: string; document: FormDocument; values: Record<string, unknown>; phase: 'change' | 'submit'; expectIssues: Array<{ code: string; path: string }> }
interface PayloadCase { id: string; document: FormDocument; values: Record<string, unknown>; expectPayload: Record<string, unknown> }

/** Run compiler / validation / payload suites against the TS core. */
export function runFormConformance(): CaseResult[] {
  const results: CaseResult[] = [];

  for (const c of formFixtures.compilation as CompilationCase[]) {
    const r = compileForm(c.document);
    const codes: string[] = r.ok ? [] : r.diagnostics.map((d) => d.code);
    let passed = r.ok === c.expectOk;
    if (passed && c.codes) passed = c.codes.every((code) => codes.includes(code));
    results.push({ suite: 'compiler', id: c.id, passed, expected: { ok: c.expectOk, codes: c.codes ?? [] }, actual: { ok: r.ok, codes } });
  }

  for (const c of formFixtures.validation as ValidationCase[]) {
    const compiled = compileForm(c.document);
    if (!compiled.ok) {
      results.push({ suite: 'validation', id: c.id, passed: false, detail: 'fixture document failed to compile', actual: compiled.diagnostics });
      continue;
    }
    const { state } = computeEffectiveState(compiled.ir, c.values);
    const v = validateValues(compiled.ir, c.values, state, { phase: c.phase });
    const actualIssues = v.issues.map((i) => ({ code: i.code, path: i.path }));
    // Every expected issue must be present (order-independent); for empty
    // expectations the result must have zero error-severity issues.
    const passed = c.expectIssues.length === 0
      ? v.issues.filter((i) => i.severity === 'error').length === 0
      : c.expectIssues.every((e) => actualIssues.some((a) => a.code === e.code && a.path === e.path));
    results.push({ suite: 'validation', id: c.id, passed, expected: c.expectIssues, actual: actualIssues });
  }

  for (const c of formFixtures.payload as PayloadCase[]) {
    const compiled = compileForm(c.document);
    if (!compiled.ok || !compiled.ir.submission) {
      results.push({ suite: 'payload', id: c.id, passed: false, detail: 'fixture document failed to compile or has no submission', actual: compiled.ok ? undefined : compiled.diagnostics });
      continue;
    }
    const { state } = computeEffectiveState(compiled.ir, c.values);
    const { payload } = buildSubmissionPayload(compiled.ir, c.values, state, compiled.ir.submission);
    const passed = deepEqual(payload, c.expectPayload);
    results.push({ suite: 'payload', id: c.id, passed, expected: c.expectPayload, actual: payload });
  }

  return results;
}


interface SecurityField { id: string; key: string; type: string; valueType: string; repeaterId?: string; parentId?: string }
const minimalIr = (fields: SecurityField[], fieldAccess?: Record<string, { read?: string[] }>) => ({
  fields,
  security: fieldAccess ? { fieldAccess } : {},
}) as never;

/** Shared hidden/unknown/read security vectors (TS reference). */
export function runSecurityConformance(): CaseResult[] {
  const results: CaseResult[] = [];
  for (const c of securityFixtures.hidden as Array<{ id: string; fields: SecurityField[]; hiddenFieldIds: string[]; values: Record<string, unknown>; expected: Record<string, unknown> }>) {
    const ir = minimalIr(c.fields);
    const visibility: Record<string, boolean> = {};
    for (const f of c.fields) visibility[f.id] = !c.hiddenFieldIds.includes(f.id);
    const templates = hiddenTemplatePaths(ir, visibility, false);
    const actual = stripPaths(c.values, templates);
    results.push({ suite: 'security-hidden', id: c.id, passed: deepEqual(actual, c.expected), expected: c.expected, actual });
  }
  for (const c of securityFixtures.unknown as Array<{ id: string; fields: SecurityField[]; values: Record<string, unknown>; expectCodes: string[] }>) {
    const issues = collectUnknownPropertyIssues(minimalIr(c.fields), c.values);
    const codes = issues.map((i) => i.code);
    const passed = c.expectCodes.length === 0 ? codes.length === 0 : c.expectCodes.every((code) => codes.includes(code));
    results.push({ suite: 'security-unknown', id: c.id, passed, expected: c.expectCodes, actual: codes });
  }
  for (const c of securityFixtures.read as Array<{ id: string; fields: SecurityField[]; fieldAccess: Record<string, { read?: string[] }>; permissions: string[]; rbac: boolean; values: Record<string, unknown>; expected: Record<string, unknown> }>) {
    const ir = minimalIr(c.fields, c.fieldAccess);
    const auth = { userId: 'u1', tenantId: 't1', roles: [], permissions: c.permissions };
    const rbac = c.rbac ? { evaluate: (_a: unknown, required: string[]) => { const missing = required.filter((p) => !c.permissions.includes(p)); return { allowed: missing.length === 0, missing }; } } : undefined;
    const policy = computeReadPolicy(ir, auth, rbac);
    const actual = filterReadableValues(ir, c.values, policy.denied);
    results.push({ suite: 'security-read', id: c.id, passed: deepEqual(actual, c.expected), expected: c.expected, actual });
  }
  return results;
}


/** Shared operation-input resource-limit / forbidden-name vectors. */
export function runOperationLimitConformance(): CaseResult[] {
  const results: CaseResult[] = [];
  for (const c of operationLimitFixtures.cases as unknown as Array<{ id: string; defs: Record<string, OperationInputDef>; values: Record<string, unknown>; expectCodes: string[] }>) {
    const { issues } = validateOperationInputs(c.defs, c.values);
    const codes = issues.map((i) => i.code);
    const passed = c.expectCodes.length === 0 ? codes.length === 0 : c.expectCodes.every((code) => codes.includes(code));
    results.push({ suite: 'operation-limits', id: c.id, passed, expected: c.expectCodes, actual: codes });
  }
  return results;
}

/** Run every conformance suite and aggregate a report. */
export function runConformance(): ConformanceReport {
  const results = [...runExpressionConformance(), ...runFormConformance(), ...runSecurityConformance(), ...runOperationLimitConformance()];
  const passed = results.filter((r) => r.passed).length;
  return {
    specVersion: CONFORMANCE_SPEC_VERSION,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
