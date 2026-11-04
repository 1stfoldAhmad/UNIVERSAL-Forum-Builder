import { describe, expect, it } from 'vitest';
import {
  evaluate, evaluateBoolean, compileDsl, DslSyntaxError, collectRefs, parseRef,
  getPath, setIn, deleteIn, deepEqual, measureExpr, roundHalfAway,
  type EvalScope,
} from '../src/index';
import type { Expr } from '@vds-form/types';

const scope = (values: Record<string, unknown>, extra: Partial<EvalScope> = {}): EvalScope => ({ values, ...extra });
const val = (expr: Expr, s: EvalScope) => {
  const r = evaluate(expr, s);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};

describe('vds.expr/1 evaluation semantics', () => {
  it('arithmetic is strict and finite', () => {
    expect(val(compileDsl('2 + 3 * 4'), scope({}))).toBe(14);
    expect(val(compileDsl('(2 + 3) * 4'), scope({}))).toBe(20);
    expect(val(compileDsl('10 / 4'), scope({}))).toBe(2.5);
    expect(val(compileDsl('10 % 3'), scope({}))).toBe(1);
    expect(evaluate(compileDsl('1 + "2"'), scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
    expect(evaluate(compileDsl('1 / 0'), scope({}))).toMatchObject({ ok: false, code: 'EXPR_DIVISION_BY_ZERO' });
  });

  it('resolves field refs, null semantics and coalesce', () => {
    const s = scope({ customer: { age: 30, name: null } });
    expect(val(compileDsl('customer.age >= 18'), s)).toBe(true);
    expect(val(compileDsl('customer.missing'), s)).toBeNull();
    expect(val(compileDsl('COALESCE(customer.name, "anon")'), s)).toBe('anon');
    expect(val(compileDsl('isEmpty(customer.name)'), s)).toBe(true);
    expect(val(compileDsl('isNull(customer.missing)'), s)).toBe(true);
  });

  it('logic is strictly boolean with short-circuit', () => {
    expect(val(compileDsl('true && false'), scope({}))).toBe(false);
    expect(val(compileDsl('false && (1/0 > 0)'), scope({}))).toBe(false); // short-circuits past div-by-zero
    expect(val(compileDsl('true || (1/0 > 0)'), scope({}))).toBe(true);
    expect(evaluate(compileDsl('1 && true'), scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
    expect(val(compileDsl('NOT false'), scope({}))).toBe(true);
  });

  it('comparison: numbers and ISO strings only, no coercion', () => {
    expect(val(compileDsl('"2026-01-02" > "2026-01-01"'), scope({}))).toBe(true);
    expect(evaluate(compileDsl('"5" > 3'), scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
    expect(val(compileDsl('"a" == "a"'), scope({}))).toBe(true);
    expect(val(compileDsl('1 == true'), scope({}))).toBe(false);
  });

  it('collections, wildcards and aggregations', () => {
    const s = scope({ items: [{ qty: 2, price: 10 }, { qty: 3, price: 5 }, { qty: 1, price: null }] });
    expect(val(compileDsl('SUM(items.*.qty)'), s)).toBe(6);
    expect(val(compileDsl('SUM(items.*.price)'), s)).toBe(15); // nulls skipped
    expect(val(compileDsl('AVG(items.*.qty)'), s)).toBe(2);
    expect(val(compileDsl('MAX(items.*.qty)'), s)).toBe(3);
    expect(val(compileDsl('COUNT(items)'), s)).toBe(3);
    expect(val(compileDsl('SUM(nothing.*.x)'), s)).toBe(0);
    expect(val(compileDsl('AVG(nothing.*.x)'), s)).toBeNull();
    expect(val(compileDsl('2 IN items.*.qty'), s)).toBe(true);
    expect(val(compileDsl('CONTAINS(items.*.qty, 3)'), s)).toBe(true);
  });

  it('repeater row scope: item, parent, index', () => {
    const s = scope(
      { discount: 10, items: [{ qty: 2, price: 10 }, { qty: 5, price: 4 }] },
      { rowPrefix: 'items.1', rowIndex: 1, parentPrefix: '' },
    );
    expect(val(compileDsl('$item.qty * $item.price'), s)).toBe(20);
    expect(val(compileDsl('$index'), s)).toBe(1);
    expect(val(compileDsl('$parent.discount'), s)).toBe(10);
    expect(evaluate(compileDsl('$item.qty'), scope({}))).toMatchObject({ ok: false, code: 'EXPR_SCOPE_ERROR' });
    expect(evaluate({ op: 'add', args: [{ ref: 'index' }, { const: 1 }] }, scope({}))).toMatchObject({ ok: false, code: 'EXPR_SCOPE_ERROR' });
  });

  it('string operators and concat budget', () => {
    expect(val(compileDsl('CONCAT("a", 1, true)'), scope({}))).toBe('a1true');
    expect(val(compileDsl('UPPER(trim("  hi "))'), scope({}))).toBe('HI');
    expect(val(compileDsl('startsWith("hello", "he")'), scope({}))).toBe(true);
    const r = evaluate({ op: 'concat', args: [{ const: 'x'.repeat(600000) }, { const: 'y'.repeat(600000) }] }, scope({}));
    expect(r).toMatchObject({ ok: false, code: 'EXPR_LIMIT_EXCEEDED' });
  });

  it('rounding is half-away-from-zero and cross-language stable', () => {
    expect(roundHalfAway(2.675, 2)).toBe(2.68);
    expect(roundHalfAway(-2.675, 2)).toBe(-2.68);
    expect(roundHalfAway(2.5, 0)).toBe(3);
    expect(roundHalfAway(-2.5, 0)).toBe(-3);
    expect(val(compileDsl('ROUND(2.675, 2)'), scope({}))).toBe(2.68);
  });

  it('date ops are deterministic (no implicit now)', () => {
    expect(val(compileDsl('dateAddDays("2026-02-27", 2)'), scope({}))).toBe('2026-03-01');
    expect(val(compileDsl('dateDiffDays("2026-03-01", "2026-02-27")'), scope({}))).toBe(2);
    expect(evaluate(compileDsl('dateAddDays("not-a-date", 1)'), scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
  });

  it('context and source refs resolve only from approved scope', () => {
    const s = scope({}, { context: { today: '2026-11-04', tenant: 't1' }, sources: { countries: ['PK', 'US'] } });
    expect(val(compileDsl('$context.today'), s)).toBe('2026-11-04');
    expect(val(compileDsl('COUNT($source.countries)'), s)).toBe(2);
    expect(val(compileDsl('$context.secret'), s)).toBeNull();
  });

  it('if is lazy and typed', () => {
    expect(val(compileDsl('IF(true, 1, 1/0)'), scope({}))).toBe(1);
    expect(evaluate(compileDsl('IF(1, 1, 2)'), scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
  });
});

describe('security & abuse resistance', () => {
  it('rejects unknown operators — no arbitrary code paths', () => {
    const evil: Expr = { op: 'eval', args: [{ const: 'process.exit(1)' }] };
    expect(evaluate(evil, scope({}))).toMatchObject({ ok: false, code: 'EXPR_UNKNOWN_OPERATOR' });
    expect(evaluate({ op: 'constructor', args: [] }, scope({}))).toMatchObject({ ok: false, code: 'EXPR_UNKNOWN_OPERATOR' });
  });

  it('blocks prototype-pollution references and paths', () => {
    expect(parseRef('field:__proto__.polluted')).toBeNull();
    expect(parseRef('field:a.constructor.prototype')).toBeNull();
    expect(getPath({}, '__proto__.polluted')).toBeUndefined();
    const polluted = setIn({} as Record<string, unknown>, '__proto__.polluted', true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(polluted).toEqual({});
    expect(evaluate({ op: 'eq', args: [{ ref: 'field:__proto__' }, { const: null }] }, scope({})))
      .toMatchObject({ ok: false, code: 'EXPR_REFERENCE_INVALID' });
  });

  it('enforces node and depth budgets', () => {
    let deep: Expr = { const: 1 };
    for (let i = 0; i < 100; i++) deep = { op: 'not', args: [{ op: 'toBoolean', args: [deep] }] };
    expect(evaluate(deep, scope({}))).toMatchObject({ ok: false, code: 'EXPR_LIMIT_EXCEEDED' });
    const wide: Expr = { op: 'add', args: Array.from({ length: 6000 }, () => ({ const: 1 })) };
    expect(evaluate(wide, scope({}))).toMatchObject({ ok: false, code: 'EXPR_LIMIT_EXCEEDED' });
  });

  it('enforces collection budgets on wildcard projections', () => {
    const big = { items: Array.from({ length: 20000 }, (_, i) => ({ x: i })) };
    expect(evaluate(compileDsl('SUM(items.*.x)'), scope(big, { limits: { maxCollectionItems: 100 } })))
      .toMatchObject({ ok: false, code: 'EXPR_LIMIT_EXCEEDED' });
  });

  it('DSL rejects malformed and oversized input', () => {
    expect(() => compileDsl('1 +')).toThrow(DslSyntaxError);
    expect(() => compileDsl('foo(1,2')).toThrow(DslSyntaxError);
    expect(() => compileDsl('EVILFN(1)')).toThrow(DslSyntaxError);
    expect(() => compileDsl('1 2')).toThrow(DslSyntaxError);
    expect(() => compileDsl('x'.repeat(5000))).toThrow(DslSyntaxError);
    expect(() => compileDsl('$weird.thing')).toThrow(DslSyntaxError);
    expect(() => compileDsl('field:__proto__')).toThrow(DslSyntaxError);
  });

  it('arity is enforced at evaluation for raw ASTs too', () => {
    expect(evaluate({ op: 'not', args: [] }, scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
    expect(evaluate({ op: 'div', args: [{ const: 1 }] }, scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
  });
});

describe('AST utilities', () => {
  it('collectRefs finds all references', () => {
    const refs = collectRefs(compileDsl('SUM(items.*.qty) + $context.x'));
    expect(refs).toEqual([
      { kind: 'field', path: 'items.*.qty' },
      { kind: 'context', path: 'x' },
    ]);
  });
  it('measureExpr counts nodes/depth', () => {
    expect(measureExpr(compileDsl('1 + 2 * 3'))).toEqual({ nodes: 5, depth: 3 });
  });
  it('setIn/deleteIn are immutable and pollution-safe', () => {
    const root = { a: { b: 1 }, list: [1, 2, 3] };
    const updated = setIn(root, 'a.b', 2);
    expect(root.a.b).toBe(1);
    expect(updated.a.b).toBe(2);
    expect(setIn(root, 'list.1', 9).list).toEqual([1, 9, 3]);
    expect(deleteIn(root, 'list.1').list).toEqual([1, 3]);
    expect(deleteIn(root, 'a.b').a).toEqual({});
  });
  it('deepEqual handles nested JSON', () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: '1' })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(true);
  });
  it('evaluateBoolean rejects non-boolean conditions', () => {
    expect(evaluateBoolean({ const: 1 }, scope({}))).toMatchObject({ ok: false, code: 'EXPR_TYPE_ERROR' });
    expect(evaluateBoolean({ const: true }, scope({}))).toMatchObject({ ok: true, value: true });
  });
});
