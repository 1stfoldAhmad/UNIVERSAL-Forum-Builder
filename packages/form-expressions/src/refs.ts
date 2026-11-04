import type { Expr, ParsedRef, RefKind } from '@vds-form/types';

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ExprLimits {
  maxNodes: number;
  maxDepth: number;
  maxCollectionItems: number;
  maxStringLength: number;
}
export const DEFAULT_LIMITS: ExprLimits = {
  maxNodes: 5000,
  maxDepth: 64,
  maxCollectionItems: 10000,
  maxStringLength: 1_000_000,
};

const REF_RE = /^(field|context|item|parent|source):([A-Za-z_][A-Za-z0-9_.\-*\[\]]*)$|^index$/;

export function parseRef(ref: string): ParsedRef | null {
  if (ref === 'index') return { kind: 'index', path: '' };
  const m = REF_RE.exec(ref);
  if (!m) return null;
  const kind = m[1] as RefKind;
  const path = m[2];
  if (path.split('.').some((s) => FORBIDDEN_SEGMENTS.has(s))) return null;
  return { kind, path };
}

export function isConstExpr(e: Expr): e is { const: never } { return 'const' in e; }
export function isRefExpr(e: Expr): e is { ref: string } { return 'ref' in e; }
export function isOpExpr(e: Expr): e is { op: string; args: Expr[] } { return 'op' in e; }

/** Count nodes and max depth; used for budget enforcement before evaluation. */
export function measureExpr(expr: Expr): { nodes: number; depth: number } {
  let nodes = 0;
  let maxDepth = 0;
  const walk = (e: Expr, d: number) => {
    nodes += 1;
    if (d > maxDepth) maxDepth = d;
    if (isOpExpr(e)) for (const a of e.args) walk(a, d + 1);
  };
  walk(expr, 1);
  return { nodes, depth: maxDepth };
}

export function collectRefs(expr: Expr): ParsedRef[] {
  const out: ParsedRef[] = [];
  const walk = (e: Expr) => {
    if (isRefExpr(e)) {
      const p = parseRef(e.ref);
      if (p) out.push(p);
    } else if (isOpExpr(e)) {
      for (const a of e.args) walk(a);
    }
  };
  walk(expr);
  return out;
}

/** Split a concrete or template path into segments. `items[].qty` → ['items','[]','qty']. */
export function splitPath(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('.')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/.exec(part);
    if (!m) return [];
    out.push(m[1]);
    if (m[2]) out.push('[]');
  }
  return out;
}

export function isSafePath(path: string): boolean {
  return path.split('.').every((s) => !FORBIDDEN_SEGMENTS.has(s.replace('[]', '')));
}

/**
 * Read a value by dot path. `*` segments project arrays (wildcard collection reads).
 * Returns undefined for missing paths. Prototype-pollution segments are rejected.
 */
export function getPath(root: unknown, path: string): unknown {
  if (!isSafePath(path)) return undefined;
  const segments = path.split('.');
  let current: unknown[] = [root];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node == null) { next.push(undefined); continue; }
      if (seg === '*') {
        if (Array.isArray(node)) next.push(...node);
        else next.push(undefined);
      } else if (/^\d+$/.test(seg) && Array.isArray(node)) {
        next.push(node[Number(seg)]);
      } else {
        if (typeof node !== 'object' || Array.isArray(node)) { next.push(undefined); continue; }
        next.push((node as Record<string, unknown>)[seg]);
      }
    }
    current = next;
  }
  // If any wildcard was present the result is a projection array.
  return segments.includes('*') ? current : current[0];
}

/** Immutable set by dot path with structural sharing. Numeric segments index arrays. */
export function setIn<T>(root: T, path: string, value: unknown): T {
  if (!isSafePath(path)) return root;
  const segments = path.split('.');
  const recur = (node: unknown, i: number): unknown => {
    if (i === segments.length) return value;
    const seg = segments[i];
    const isIndex = /^\d+$/.test(seg);
    if (isIndex) {
      const arr = Array.isArray(node) ? [...node] : [];
      const idx = Number(seg);
      arr[idx] = recur(arr[idx], i + 1);
      return arr;
    }
    const obj = typeof node === 'object' && node !== null && !Array.isArray(node)
      ? { ...(node as Record<string, unknown>) } : {};
    obj[seg] = recur(obj[seg], i + 1);
    return obj;
  };
  return recur(root, 0) as T;
}

/** Delete by dot path (immutable). Array indices splice. */
export function deleteIn<T>(root: T, path: string): T {
  if (!isSafePath(path)) return root;
  const segments = path.split('.');
  const recur = (node: unknown, i: number): unknown => {
    if (node == null || typeof node !== 'object') return node;
    const seg = segments[i];
    if (i === segments.length - 1) {
      if (Array.isArray(node) && /^\d+$/.test(seg)) {
        const arr = [...node];
        arr.splice(Number(seg), 1);
        return arr;
      }
      const obj = { ...(node as Record<string, unknown>) };
      delete obj[seg];
      return obj;
    }
    if (Array.isArray(node) && /^\d+$/.test(seg)) {
      const arr = [...node];
      arr[Number(seg)] = recur(arr[Number(seg)], i + 1);
      return arr;
    }
    const obj = { ...(node as Record<string, unknown>) };
    obj[seg] = recur(obj[seg], i + 1);
    return obj;
  };
  return recur(root, 0) as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object); const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
