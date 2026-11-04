/**
 * vds.expr/1 closed operator set. Every operator is typed and deterministic.
 * Errors are returned as values (EvalError), never thrown across boundaries.
 * The same semantics are implemented by the Django and Laravel execution adapters
 * and verified against shared conformance fixtures.
 */
import { deepEqual } from './refs';

export interface EvalError { ok: false; code: string; message: string }
export interface EvalOk { ok: true; value: unknown }
export type EvalResult = EvalOk | EvalError;

export const err = (code: string, message: string): EvalError => ({ ok: false, code, message });
export const okv = (value: unknown): EvalOk => ({ ok: true, value });

export type OpImpl = (args: unknown[], limits: { maxCollectionItems: number; maxStringLength: number }) => EvalResult;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const norm = (v: unknown): unknown => (v === undefined ? null : v);

function numbers(args: unknown[], skipNull = false): { ok: true; value: number[] } | EvalError {
  // Accept a single array of numbers (wildcard projection) or variadic numbers.
  let list = args;
  if (args.length === 1 && Array.isArray(args[0])) list = args[0];
  const out: number[] = [];
  for (const v of list) {
    const n = norm(v);
    if (n === null && skipNull) continue; // collection aggregations skip nulls (documented)
    if (!isNum(n)) return err('EXPR_TYPE_ERROR', `Arithmetic expects finite numbers, got ${n === null ? 'null' : typeof n}.`);
    out.push(n);
  }
  return { ok: true, value: out };
}

/** Round half away from zero with 15-significant-digit correction (cross-language stable). */
export function roundHalfAway(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const factor = 10 ** digits;
  const scaled = Number((Math.abs(x) * factor).toPrecision(15));
  const rounded = Math.round(scaled);
  return Math.sign(x) * rounded / factor;
}

function finite(v: number): EvalResult {
  return Number.isFinite(v) ? okv(v) : err('EXPR_OVERFLOW', 'Numeric result is not finite.');
}

function isoDate(v: unknown): number | null {
  if (!isStr(v)) return null;
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v)) return null;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(t) ? null : t;
}

export const OPERATORS: Record<string, OpImpl> = {
  /* logic — strict booleans, short-circuit handled by evaluator for and/or */
  and: (args) => args.every(isBool) ? okv(args.every(Boolean)) : err('EXPR_TYPE_ERROR', 'and expects booleans.'),
  or: (args) => args.every(isBool) ? okv(args.some(Boolean)) : err('EXPR_TYPE_ERROR', 'or expects booleans.'),
  not: (args) => isBool(args[0]) ? okv(!args[0]) : err('EXPR_TYPE_ERROR', 'not expects a boolean.'),
  if: (args) => isBool(args[0]) ? okv(norm(args[0] ? args[1] : args[2])) : err('EXPR_TYPE_ERROR', 'if expects a boolean condition.'),
  coalesce: (args) => { for (const a of args) if (norm(a) !== null) return okv(a); return okv(null); },

  /* comparison */
  eq: (args) => okv(deepEqual(norm(args[0]), norm(args[1]))),
  neq: (args) => okv(!deepEqual(norm(args[0]), norm(args[1]))),
  gt: cmp((a, b) => a > b), gte: cmp((a, b) => a >= b),
  lt: cmp((a, b) => a < b), lte: cmp((a, b) => a <= b),

  /* null / empty */
  isNull: (args) => okv(norm(args[0]) === null),
  isEmpty: (args) => {
    const v = norm(args[0]);
    if (v === null) return okv(true);
    if (isStr(v)) return okv(v.length === 0);
    if (Array.isArray(v)) return okv(v.length === 0);
    if (typeof v === 'object') return okv(Object.keys(v as object).length === 0);
    return okv(false);
  },
  in: (args) => Array.isArray(args[1])
    ? okv(args[1].some((v) => deepEqual(norm(v), norm(args[0]))))
    : err('EXPR_TYPE_ERROR', 'in expects (value, array).'),
  contains: (args) => {
    const c = norm(args[0]);
    if (isStr(c) && isStr(args[1])) return okv(c.includes(args[1]));
    if (Array.isArray(c)) return okv(c.some((v) => deepEqual(norm(v), norm(args[1]))));
    return err('EXPR_TYPE_ERROR', 'contains expects (string, string) or (array, value).');
  },

  /* strings */
  concat: (args, limits) => {
    let out = '';
    for (const a of args) {
      const v = norm(a);
      if (v === null) continue;
      if (!isStr(v) && !isNum(v) && !isBool(v)) return err('EXPR_TYPE_ERROR', 'concat expects strings/numbers/booleans.');
      out += String(v);
      if (out.length > limits.maxStringLength) return err('EXPR_LIMIT_EXCEEDED', 'concat exceeded string budget.');
    }
    return okv(out);
  },
  len: (args, limits) => {
    const v = norm(args[0]);
    if (isStr(v)) return okv(v.length);
    if (Array.isArray(v)) return v.length > limits.maxCollectionItems ? err('EXPR_LIMIT_EXCEEDED', 'Collection too large.') : okv(v.length);
    if (v === null) return okv(0);
    return err('EXPR_TYPE_ERROR', 'len expects string or array.');
  },
  startsWith: (args) => isStr(args[0]) && isStr(args[1]) ? okv(args[0].startsWith(args[1])) : err('EXPR_TYPE_ERROR', 'startsWith expects strings.'),
  endsWith: (args) => isStr(args[0]) && isStr(args[1]) ? okv(args[0].endsWith(args[1])) : err('EXPR_TYPE_ERROR', 'endsWith expects strings.'),
  lower: (args) => isStr(args[0]) ? okv(args[0].toLowerCase()) : err('EXPR_TYPE_ERROR', 'lower expects a string.'),
  upper: (args) => isStr(args[0]) ? okv(args[0].toUpperCase()) : err('EXPR_TYPE_ERROR', 'upper expects a string.'),
  trim: (args) => isStr(args[0]) ? okv(args[0].trim()) : err('EXPR_TYPE_ERROR', 'trim expects a string.'),

  /* arithmetic — strict finite numbers */
  add: (args) => { const n = numbers(args); if (!n.ok) return n; return finite(n.value.reduce((a, b) => a + b, 0)); },
  mul: (args) => { const n = numbers(args); if (!n.ok) return n; return finite(n.value.reduce((a, b) => a * b, 1)); },
  sub: (args) => { const n = numbers(args); if (!n.ok) return n; if (n.value.length === 0) return okv(0); return finite(n.value.reduce((a, b) => a - b)); },
  div: (args) => {
    if (!isNum(args[0]) || !isNum(args[1])) return err('EXPR_TYPE_ERROR', 'div expects numbers.');
    if (args[1] === 0) return err('EXPR_DIVISION_BY_ZERO', 'Division by zero.');
    return finite(args[0] / args[1]);
  },
  mod: (args) => {
    if (!isNum(args[0]) || !isNum(args[1])) return err('EXPR_TYPE_ERROR', 'mod expects numbers.');
    if (args[1] === 0) return err('EXPR_DIVISION_BY_ZERO', 'Modulo by zero.');
    return finite(args[0] % args[1]);
  },
  abs: (args) => isNum(args[0]) ? okv(Math.abs(args[0])) : err('EXPR_TYPE_ERROR', 'abs expects a number.'),
  round: (args) => {
    if (!isNum(args[0])) return err('EXPR_TYPE_ERROR', 'round expects a number.');
    const d = args.length > 1 ? args[1] : 0;
    if (!isNum(d) || !Number.isInteger(d) || d < 0 || d > 10) return err('EXPR_TYPE_ERROR', 'round digits must be integer 0..10.');
    return okv(roundHalfAway(args[0], d));
  },
  sum: (args) => { const n = numbers(args, true); if (!n.ok) return n; return finite(n.value.reduce((a, b) => a + b, 0)); },
  avg: (args) => { const n = numbers(args, true); if (!n.ok) return n; return n.value.length ? finite(n.value.reduce((a, b) => a + b, 0) / n.value.length) : okv(null); },
  min: (args) => { const n = numbers(args, true); if (!n.ok) return n; return okv(n.value.length ? Math.min(...n.value) : null); },
  max: (args) => { const n = numbers(args, true); if (!n.ok) return n; return okv(n.value.length ? Math.max(...n.value) : null); },
  count: (args) => {
    const v = norm(args[0]);
    if (Array.isArray(v)) return okv(v.length);
    if (v === null) return okv(0);
    return err('EXPR_TYPE_ERROR', 'count expects an array.');
  },

  /* explicit conversions */
  toNumber: (args) => {
    const v = norm(args[0]);
    if (v === null) return okv(null);
    if (isNum(v)) return okv(v);
    if (isBool(v)) return okv(v ? 1 : 0);
    if (isStr(v) && v.trim() !== '' && Number.isFinite(Number(v))) return okv(Number(v));
    return err('EXPR_TYPE_ERROR', 'toNumber cannot convert value.');
  },
  toString: (args: unknown[]) => { const v = norm(args[0]); return okv(v === null ? '' : isStr(v) ? v : isNum(v) || isBool(v) ? String(v) : JSON.stringify(v)); },
  toBoolean: (args) => {
    const v = norm(args[0]);
    if (isBool(v)) return okv(v);
    if (v === null) return okv(false);
    if (isNum(v)) return okv(v !== 0);
    if (isStr(v)) return okv(v.length > 0);
    if (Array.isArray(v)) return okv(v.length > 0);
    return okv(true);
  },

  /* approved deterministic date ops (ISO strings; no implicit "now") */
  dateAddDays: (args) => {
    const t = isoDate(args[0]);
    if (t === null || !isNum(args[1]) || !Number.isInteger(args[1])) return err('EXPR_TYPE_ERROR', 'dateAddDays expects (ISO date, integer days).');
    return okv(new Date(t + args[1] * 86400000).toISOString().slice(0, 10));
  },
  dateDiffDays: (args) => {
    const a = isoDate(args[0]); const b = isoDate(args[1]);
    if (a === null || b === null) return err('EXPR_TYPE_ERROR', 'dateDiffDays expects ISO dates.');
    return okv(Math.round((a - b) / 86400000));
  },
};

function cmp(fn: (a: number | string, b: number | string) => boolean): OpImpl {
  return (args) => {
    const a = norm(args[0]); const b = norm(args[1]);
    if (isNum(a) && isNum(b)) return okv(fn(a, b));
    if (isStr(a) && isStr(b)) return okv(fn(a, b)); // lexicographic — valid for ISO dates
    return err('EXPR_TYPE_ERROR', 'Comparison expects two numbers or two strings.');
  };
}

export const OPERATOR_NAMES = Object.keys(OPERATORS);

/** Arity table for compile-time validation. [min, max] (-1 = variadic). */
export const OPERATOR_ARITY: Record<string, [number, number]> = {
  and: [1, -1], or: [1, -1], not: [1, 1], if: [3, 3], coalesce: [1, -1],
  eq: [2, 2], neq: [2, 2], gt: [2, 2], gte: [2, 2], lt: [2, 2], lte: [2, 2],
  isNull: [1, 1], isEmpty: [1, 1], in: [2, 2], contains: [2, 2],
  concat: [0, -1], len: [1, 1], startsWith: [2, 2], endsWith: [2, 2],
  lower: [1, 1], upper: [1, 1], trim: [1, 1],
  add: [0, -1], mul: [0, -1], sub: [1, -1], div: [2, 2], mod: [2, 2],
  abs: [1, 1], round: [1, 2], sum: [1, -1], avg: [1, -1], min: [1, -1], max: [1, -1], count: [1, 1],
  toNumber: [1, 1], toString: [1, 1] as [number, number], toBoolean: [1, 1],
  dateAddDays: [2, 2], dateDiffDays: [2, 2],
};
