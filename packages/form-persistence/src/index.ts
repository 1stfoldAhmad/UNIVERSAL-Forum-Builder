/**
 * @vds-form/persistence — draft + offline queue contracts and in-memory adapters.
 * Platform adapters (SecureStore, SQLite, localStorage, IndexedDB…) implement the
 * same contracts separately. Scope keys enforce user/tenant isolation.
 */
import type {
  AuthContext, DraftEnvelope, DraftStorageAdapter, FormIR, FormValues,
  OfflineQueueAdapter, PersistenceDef, QueuedSubmissionRecord,
} from '@vds-form/types';
import type { FieldRegistry } from '@vds-form/fields';
import { stripPaths } from '@vds-form/validation';

/** Template paths for fields whose registry contract marks them sensitive. */
export function sensitiveTemplatePaths(ir: FormIR, fields: FieldRegistry): string[] {
  return ir.fields.filter((f) => fields.get(f.type)?.sensitive === true).map((f) => f.key);
}

/** Remove sensitive subtrees (including repeater rows) before persistence. */
export function stripSensitiveValues(values: FormValues, sensitivePaths: string[]): FormValues {
  if (sensitivePaths.length === 0) return values;
  return (stripPaths(values, sensitivePaths) ?? {}) as FormValues;
}

export function draftScopeKey(def: PersistenceDef, auth?: AuthContext, deviceId = 'device'): string {
  const scope = def.drafts?.scope ?? 'device';
  if (scope === 'user') return `user:${auth?.tenantId ?? 'no-tenant'}:${auth?.userId ?? 'anonymous'}`;
  if (scope === 'tenant') return `tenant:${auth?.tenantId ?? 'no-tenant'}`;
  return `device:${deviceId}`;
}

export class MemoryDraftStorage implements DraftStorageAdapter {
  private store = new Map<string, DraftEnvelope>();
  private key(formId: string, scopeKey: string) { return `${scopeKey}::${formId}`; }
  async save(envelope: DraftEnvelope): Promise<void> {
    this.store.set(this.key(envelope.formId, envelope.scopeKey), structuredClone(envelope));
  }
  async load(formId: string, scopeKey: string): Promise<DraftEnvelope | null> {
    const e = this.store.get(this.key(formId, scopeKey));
    if (!e) return null;
    if (e.expiresAt && Date.parse(e.expiresAt) < Date.now()) { this.store.delete(this.key(formId, scopeKey)); return null; }
    return structuredClone(e);
  }
  async clear(formId: string, scopeKey: string): Promise<void> {
    this.store.delete(this.key(formId, scopeKey));
  }
}

export class MemoryOfflineQueue implements OfflineQueueAdapter {
  private records = new Map<string, QueuedSubmissionRecord>();
  async enqueue(record: QueuedSubmissionRecord): Promise<void> {
    // Duplicate protection: same idempotency key + scope never enqueued twice.
    for (const r of this.records.values()) {
      if (r.scopeKey === record.scopeKey && r.idempotencyKey === record.idempotencyKey && r.status !== 'sent' && r.status !== 'cancelled') {
        throw new Error(`QUEUE_DUPLICATE: idempotency key already queued (${record.idempotencyKey}).`);
      }
    }
    this.records.set(record.id, structuredClone(record));
  }
  async list(scopeKey: string): Promise<QueuedSubmissionRecord[]> {
    return [...this.records.values()].filter((r) => r.scopeKey === scopeKey).map((r) => structuredClone(r));
  }
  async update(id: string, patch: Partial<QueuedSubmissionRecord>): Promise<void> {
    const r = this.records.get(id);
    if (!r) throw new Error(`QUEUE_RECORD_NOT_FOUND: ${id}`);
    this.records.set(id, { ...r, ...patch, id: r.id, scopeKey: r.scopeKey });
  }
  async remove(id: string): Promise<void> { this.records.delete(id); }
}

export interface DraftLoadResult {
  status: 'none' | 'restored' | 'expired' | 'conflict';
  envelope?: DraftEnvelope;
  reason?: string;
}

/** Version-aware draft restore policy: never silently apply a mismatched version. */
export async function loadDraftChecked(
  storage: DraftStorageAdapter, formId: string, formVersion: string, scopeKey: string,
): Promise<DraftLoadResult> {
  const envelope = await storage.load(formId, scopeKey);
  if (!envelope) return { status: 'none' };
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) < Date.now()) {
    await storage.clear(formId, scopeKey);
    return { status: 'expired', reason: 'Draft expired.' };
  }
  if (envelope.formVersion !== formVersion) {
    return { status: 'conflict', envelope, reason: `Draft was saved for form version ${envelope.formVersion}; current is ${formVersion}.` };
  }
  return { status: 'restored', envelope };
}

export function makeDraftEnvelope(
  formId: string, formVersion: string, specVersion: string, scopeKey: string,
  values: FormValues, ttlSeconds?: number, now: Date = new Date(),
  options: { sensitivePaths?: string[] } = {},
): DraftEnvelope {
  // Never persist device-local asset handles into drafts.
  const scrub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      if ('localUri' in rec && !('assetRef' in rec)) return null;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(rec)) out[k] = scrub(val);
      return out;
    }
    return v;
  };
  return {
    envelopeVersion: 1, formId, formVersion, specVersion, scopeKey,
    values: scrub(stripSensitiveValues(values, options.sensitivePaths ?? [])) as FormValues,
    savedAt: now.toISOString(),
    expiresAt: ttlSeconds ? new Date(now.getTime() + ttlSeconds * 1000).toISOString() : undefined,
  };
}
