/**
 * Security acceptance tests (spec §24 / R24). These assert the hard security
 * guarantees of the canonical standard: no code execution, prototype-pollution
 * resistance, ReDoS resistance, expression budgets, secret redaction, payload
 * hygiene, and fail-closed authorization.
 */
import { describe, expect, it } from 'vitest';
import {
  getPath, setIn, deleteIn, evaluate, compileDsl, DslSyntaxError, DEFAULT_LIMITS,
  isSafePattern, compileForm, FormController, buildSubmissionPayload,
  computeEffectiveState, validateValues,
} from '@vds-form/core';
import { inspectRuntime } from '@vds-form/inspector';
import { TrustedSubmissionHandler, OperationRegistry } from '@vds-form/execution-node';
import type { Expr, FormDocument } from '@vds-form/types';

const doc = (fields: unknown[], extra: Record<string, unknown> = {}): FormDocument => ({
  format: 'vds.form', specVersion: '1.0.0', id: 'sec', metadata: { name: 'Sec', version: '1.0.0' },
  fields, submission: { operationRef: 'test:save' }, ...extra,
} as unknown as FormDocument);

describe('security: prototype pollution resistance', () => {
  it('getPath rejects __proto__/constructor/prototype segments', () => {
    const obj = { safe: 1 };
    expect(getPath(obj, '__proto__')).toBeUndefined();
    expect(getPath(obj, 'constructor.prototype')).toBeUndefined();
    expect(getPath(obj, 'safe.__proto__')).toBeUndefined();
  });

  it('setIn cannot pollute Object.prototype', () => {
    const target = {};
    setIn(target, '__proto__.polluted', true);
    setIn(target, 'constructor.prototype.polluted2', true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });

  it('deleteIn cannot traverse forbidden segments', () => {
    const target = { a: 1 };
    const result = deleteIn(target, '__proto__.toString');
    expect(result).toEqual({ a: 1 });
    expect(typeof ({} as object).toString).toBe('function');
  });

  it('expression refs with forbidden segments are invalid', () => {
    const r = evaluate({ ref: 'field:__proto__.polluted' } as Expr, { values: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXPR_REFERENCE_INVALID');
  });
});

describe('security: no arbitrary code execution', () => {
  it('unknown operators are rejected (closed registry, no eval)', () => {
    const r = evaluate({ op: 'eval', args: [{ const: 'process.exit(1)' }] } as unknown as Expr, { values: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXPR_UNKNOWN_OPERATOR');
  });

  it('the DSL cannot express function calls outside the operator set', () => {
    expect(() => compileDsl('require("fs")')).toThrow(DslSyntaxError);
    expect(() => compileDsl('foo(1)')).toThrow(DslSyntaxError);
    // A bare dotted name is only a field reference — it resolves to data (null
    // when absent), never to a live global object or executable code.
    const ast = compileDsl('globalThis.process');
    const r = evaluate(ast, { values: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('DSL enforces a hard length budget', () => {
    expect(() => compileDsl('1 + '.repeat(3000) + '1')).toThrow(DslSyntaxError);
  });
});

describe('security: ReDoS resistance', () => {
  it('isSafePattern rejects nested quantifiers and over-long patterns', () => {
    expect(isSafePattern('(a+)+$')).toBe(false);
    expect(isSafePattern('(a*)*')).toBe(false);
    expect(isSafePattern('a'.repeat(1001))).toBe(false);
    expect(isSafePattern('^[a-z]+$')).toBe(true);
  });

  it('validation surfaces PATTERN_UNSAFE instead of running a catastrophic regex', () => {
    const compiled = compileForm(doc([{ id: 'x', type: 'text', key: 'x', label: 'X', validation: { pattern: '(a+)+$' } }]));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const { state } = computeEffectiveState(compiled.ir, { x: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' });
    const result = validateValues(compiled.ir, { x: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' }, state, { phase: 'submit' });
    expect(result.issues.some((i) => i.code === 'PATTERN_UNSAFE')).toBe(true);
  });
});

describe('security: expression budgets', () => {
  it('rejects expressions exceeding the node budget', () => {
    let expr: Expr = { const: 1 };
    for (let i = 0; i < 6000; i++) expr = { op: 'add', args: [expr, { const: 1 }] };
    const r = evaluate(expr, { values: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXPR_LIMIT_EXCEEDED');
  });

  it('rejects expressions exceeding the depth budget', () => {
    let expr: Expr = { const: true };
    for (let i = 0; i < 100; i++) expr = { op: 'not', args: [expr] };
    const r = evaluate(expr, { values: {}, limits: { maxDepth: 10 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXPR_LIMIT_EXCEEDED');
  });

  it('wildcard projection enforces the collection budget', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ v: i }));
    const r = evaluate({ ref: 'field:items.*.v' } as Expr, { values: { items: big }, limits: { maxCollectionItems: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXPR_LIMIT_EXCEEDED');
  });

  it('concat enforces the string budget', () => {
    const r = evaluate({ op: 'concat', args: [{ const: 'x'.repeat(50) }, { const: 'y'.repeat(50) }] } as Expr, { values: {}, limits: { maxStringLength: 60 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXPR_LIMIT_EXCEEDED');
  });

  it('default limits are finite and conservative', () => {
    expect(DEFAULT_LIMITS.maxNodes).toBeLessThanOrEqual(5000);
    expect(DEFAULT_LIMITS.maxDepth).toBeLessThanOrEqual(64);
  });
});

describe('security: secret redaction', () => {
  it('inspector redacts sensitive (password) values by default', async () => {
    const compiled = compileForm(doc([{ id: 'pw', type: 'password', key: 'pw', label: 'Password' }]));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const controller = new FormController({ ir: compiled.ir });
    await controller.initialize();
    controller.setFieldValue('pw', 'super-secret-value');
    const inspection = inspectRuntime(controller, { includeValues: true });
    const pw = inspection.fields.find((f) => f.id === 'pw')!;
    expect(pw.value).toBe('[REDACTED]');
    expect(JSON.stringify(inspection)).not.toContain('super-secret-value');
    controller.dispose();
  });
});

describe('security: payload hygiene', () => {
  it('strips hidden fields and rejects un-uploaded local assets', () => {
    const compiled = compileForm(doc([
      { id: 'type', type: 'text', key: 'type', label: 'Type' },
      { id: 'secret', type: 'text', key: 'secret', label: 'Secret', hidden: true },
      { id: 'file', type: 'file', key: 'file', label: 'File' },
    ]));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok || !compiled.ir.submission) return;
    const values = { type: 'a', secret: 'leak', file: { localUri: 'file:///tmp/x', name: 'x', mimeType: 'image/png', sizeBytes: 1 } };
    const { state } = computeEffectiveState(compiled.ir, values);
    const { payload, issues } = buildSubmissionPayload(compiled.ir, values, state, compiled.ir.submission);
    expect(payload.secret).toBeUndefined();
    expect(issues.some((i) => i.code === 'ASSET_NOT_UPLOADED')).toBe(true);
  });
});

describe('security: fail-closed authorization (trusted server)', () => {
  const irOf = (extra: Record<string, unknown> = {}) => {
    const compiled = compileForm(doc([{ id: 'name', type: 'text', key: 'name', label: 'Name', required: true }], extra));
    if (!compiled.ok) throw new Error('compile');
    return compiled.ir;
  };

  it('declared submitPermissions with no evaluator → RBAC_NOT_CONFIGURED', async () => {
    const ir = irOf({ security: { submitPermissions: ['x:write'] } });
    const ops = new OperationRegistry();
    ops.register('test:save', () => ({ ok: true }));
    const handler = new TrustedSubmissionHandler({ forms: { sec: ir }, operations: ops });
    const result = await handler.handle({ formId: 'sec', values: { name: 'Ada' }, idempotencyKey: 'k', correlationId: 'c' });
    expect(result.status).toBe('permission-denied');
    if (result.status === 'permission-denied') expect(result.code).toBe('RBAC_NOT_CONFIGURED');
  });

  it('audit records value paths only, never the submitted values', async () => {
    const ir = irOf();
    const ops = new OperationRegistry();
    ops.register('test:save', () => ({ ok: true }));
    const entries: Array<Record<string, unknown>> = [];
    const handler = new TrustedSubmissionHandler({ forms: { sec: ir }, operations: ops, audit: (e) => entries.push(e as unknown as Record<string, unknown>) });
    await handler.handle({ formId: 'sec', values: { name: 'Top Secret Name' }, idempotencyKey: 'k', correlationId: 'c' });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('Top Secret Name');
    expect(entries[0].valuePaths).toEqual(['name']);
  });
});
