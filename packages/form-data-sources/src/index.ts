/**
 * @vds-form/data-sources — registered provider contracts + option mapping.
 * Forms declare data needs; providers execute actual queries. No URLs/credentials
 * ever live in form documents.
 */
import type {
  DataSourceDef, DataSourceProvider, DataSourceRequest, DataSourceResponse,
  Expr, FieldOption,
} from '@vds-form/types';
import { evaluate, type EvalScope } from '@vds-form/expressions';

export class DataSourceProviderRegistry {
  private providers = new Map<string, DataSourceProvider>();

  register(provider: DataSourceProvider): void {
    if (this.providers.has(provider.scheme)) {
      throw new Error(`DATA_PROVIDER_DUPLICATE: scheme "${provider.scheme}" already registered.`);
    }
    this.providers.set(provider.scheme, provider);
  }
  unregister(scheme: string): boolean { return this.providers.delete(scheme); }
  get(scheme: string): DataSourceProvider | undefined { return this.providers.get(scheme); }
  forRef(providerRef: string): DataSourceProvider | undefined {
    return this.providers.get(providerRef.split(':')[0] ?? '');
  }
  schemes(): string[] { return [...this.providers.keys()].sort(); }
}

/** Evaluate declared params (constants or expressions) against current values. */
export function evaluateParams(
  def: DataSourceDef, scope: EvalScope,
): { params: Record<string, unknown>; error?: string } {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def.params ?? {})) {
    if (typeof v === 'object' && v !== null && ('ref' in v || 'op' in v || 'const' in v)) {
      const r = evaluate(v as Expr, scope);
      if (!r.ok) return { params: {}, error: `${k}: ${r.message}` };
      params[k] = r.value;
    } else {
      params[k] = v;
    }
  }
  return { params };
}

export function mapOptions(items: unknown[], valueKey: string, labelKey: string): FieldOption[] {
  const out: FieldOption[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        out.push({ value: item, label: String(item) });
      }
      continue;
    }
    const rec = item as Record<string, unknown>;
    const value = rec[valueKey];
    const label = rec[labelKey];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push({ value, label: typeof label === 'string' ? label : String(value) });
    }
  }
  return out;
}

/** Canonical recursive JSON serializer for cache keys: object keys sorted at
 * every depth, arrays order-sensitive, null/primitives JSON-encoded. Unlike a
 * shallow JSON.stringify replacer, nested filters cannot collide. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface CachedEntry { response: DataSourceResponse; fetchedAt: number; paramsKey: string }

/** TTL cache keyed by source id + evaluated params (deterministic key). */
export class DataSourceCache {
  private entries = new Map<string, CachedEntry>();
  key(sourceId: string, params: Record<string, unknown>): string {
    return `${sourceId}|${canonicalJson(params)}`;
  }
  get(key: string, ttlMs: number, now: number): DataSourceResponse | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (now - e.fetchedAt > ttlMs) { this.entries.delete(key); return undefined; }
    return e.response;
  }
  set(key: string, response: DataSourceResponse, paramsKey: string, now: number): void {
    this.entries.set(key, { response, fetchedAt: now, paramsKey });
  }
  clear(): void { this.entries.clear(); }
}

export type { DataSourceRequest, DataSourceResponse, DataSourceProvider };
