import type { Expr } from '@vds-form/types';
import {
  DEFAULT_LIMITS, getPath, isConstExpr, isOpExpr, isRefExpr, measureExpr, parseRef,
  type ExprLimits,
} from './refs';
import { OPERATORS, OPERATOR_ARITY, err, okv, type EvalResult } from './operators';

export interface EvalScope {
  /** Concrete form values. */
  values: Record<string, unknown>;
  /** Approved, non-secret context (e.g. today, locale, tenant-safe facts). */
  context?: Record<string, unknown>;
  /** Resolved data-source values by source id. */
  sources?: Record<string, unknown>;
  /** Repeater row scope. */
  rowPrefix?: string;
  rowIndex?: number;
  parentPrefix?: string;
  limits?: Partial<ExprLimits>;
  /** Extra named functions registered by plugins (closed registry, typed impls). */
  functions?: Record<string, (args: unknown[]) => EvalResult>;
}

export function resolveRef(ref: string, scope: EvalScope): EvalResult {
  const parsed = parseRef(ref);
  if (!parsed) return err('EXPR_REFERENCE_INVALID', `Invalid reference "${ref}".`);
  switch (parsed.kind) {
    case 'field': {
      const v = getPath(scope.values, parsed.path);
      if (Array.isArray(v) && parsed.path.includes('*') && v.length > (scope.limits?.maxCollectionItems ?? DEFAULT_LIMITS.maxCollectionItems)) {
        return err('EXPR_LIMIT_EXCEEDED', 'Wildcard projection exceeded collection budget.');
      }
      return okv(v === undefined ? null : v);
    }
    case 'item':
      if (scope.rowPrefix === undefined) return err('EXPR_SCOPE_ERROR', `item: reference "${ref}" used outside a repeater row.`);
      return okv(getPath(scope.values, `${scope.rowPrefix}.${parsed.path}`) ?? null);
    case 'parent': {
      const full = scope.parentPrefix ? `${scope.parentPrefix}.${parsed.path}` : parsed.path;
      return okv(getPath(scope.values, full) ?? null);
    }
    case 'index':
      if (scope.rowIndex === undefined) return err('EXPR_SCOPE_ERROR', 'index reference used outside a repeater row.');
      return okv(scope.rowIndex);
    case 'context':
      return okv(getPath(scope.context ?? {}, parsed.path) ?? null);
    case 'source':
      return okv(scope.sources?.[parsed.path] ?? null);
  }
}

/**
 * Evaluate a canonical vds.expr/1 AST. Deterministic, budgeted, no code execution.
 * `and`/`or` short-circuit; all other operators receive evaluated arguments.
 */
export function evaluate(expr: Expr, scope: EvalScope): EvalResult {
  const limits: ExprLimits = { ...DEFAULT_LIMITS, ...scope.limits };
  const measured = measureExpr(expr);
  if (measured.nodes > limits.maxNodes) return err('EXPR_LIMIT_EXCEEDED', `Expression has ${measured.nodes} nodes (max ${limits.maxNodes}).`);
  if (measured.depth > limits.maxDepth) return err('EXPR_LIMIT_EXCEEDED', `Expression depth ${measured.depth} exceeds max ${limits.maxDepth}.`);

  let budget = limits.maxNodes * 4; // evaluation steps incl. short-circuit re-visits
  const step = (): EvalResult | null => {
    budget -= 1;
    return budget < 0 ? err('EXPR_LIMIT_EXCEEDED', 'Evaluation budget exhausted.') : null;
  };

  const evalNode = (e: Expr, depth: number): EvalResult => {
    const over = step();
    if (over) return over;
    if (depth > limits.maxDepth) return err('EXPR_LIMIT_EXCEEDED', 'Depth budget exceeded.');
    if (isConstExpr(e)) return okv(e.const);
    if (isRefExpr(e)) return resolveRef(e.ref, { ...scope, limits });
    if (!isOpExpr(e)) return err('EXPR_REFERENCE_INVALID', 'Malformed expression node.');

    const ownOp = Object.hasOwn(OPERATORS, e.op);
    const ownFn = scope.functions !== undefined && Object.hasOwn(scope.functions, e.op);
    if (!ownOp && !ownFn) return err('EXPR_UNKNOWN_OPERATOR', `Unknown operator "${e.op}".`);
    const arity = ownOp ? OPERATOR_ARITY[e.op] : undefined;
    if (arity) {
      const [min, max] = arity;
      if (e.args.length < min || (max !== -1 && e.args.length > max)) {
        return err('EXPR_TYPE_ERROR', `Operator "${e.op}" expects ${max === -1 ? `>=${min}` : min === max ? `${min}` : `${min}..${max}`} args, got ${e.args.length}.`);
      }
    }

    // Short-circuit logic with strict boolean typing.
    if (e.op === 'and' || e.op === 'or') {
      for (const a of e.args) {
        const r = evalNode(a, depth + 1);
        if (!r.ok) return r;
        if (typeof r.value !== 'boolean') return err('EXPR_TYPE_ERROR', `${e.op} expects booleans.`);
        if (e.op === 'and' && r.value === false) return okv(false);
        if (e.op === 'or' && r.value === true) return okv(true);
      }
      return okv(e.op === 'and');
    }
    if (e.op === 'if') {
      const c = evalNode(e.args[0], depth + 1);
      if (!c.ok) return c;
      if (typeof c.value !== 'boolean') return err('EXPR_TYPE_ERROR', 'if expects a boolean condition.');
      return evalNode(c.value ? e.args[1] : e.args[2], depth + 1);
    }
    if (e.op === 'coalesce') {
      for (const a of e.args) {
        const r = evalNode(a, depth + 1);
        if (!r.ok) return r;
        if (r.value !== null && r.value !== undefined) return okv(r.value);
      }
      return okv(null);
    }

    const args: unknown[] = [];
    for (const a of e.args) {
      const r = evalNode(a, depth + 1);
      if (!r.ok) return r;
      args.push(r.value);
    }
    if (ownOp) return OPERATORS[e.op](args, limits);
    return scope.functions![e.op](args);
  };

  return evalNode(expr, 1);
}

/** Evaluate and require a boolean result (conditions). */
export function evaluateBoolean(expr: Expr, scope: EvalScope): EvalResult {
  const r = evaluate(expr, scope);
  if (!r.ok) return r;
  if (typeof r.value !== 'boolean') return err('EXPR_TYPE_ERROR', 'Condition must evaluate to a boolean.');
  return r;
}
