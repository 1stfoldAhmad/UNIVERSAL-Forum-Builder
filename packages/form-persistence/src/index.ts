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

/* ------------------------------------------------------------------ */
/* Durable host-storage adapters (browser / Expo)                      */
/* ------------------------------------------------------------------ */

/** Minimal async key-value contract implemented by durable host storage.
 * Browser localStorage, Expo AsyncStorage, and Expo SecureStore adapters are
 * provided below. The store itself must survive application restarts. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const draftKey = (formId: string, scopeKey: string) => `vds:draft:${scopeKey}:${formId}`;
const queueKey = (scopeKey: string, id: string) => `vds:queue:${scopeKey}:${id}`;
const queueIndexKey = (scopeKey: string) => `vds:queue-index:${scopeKey}`;
const queueGlobalIndexKey = 'vds:queue-global-index';

/** Durable draft storage over any KeyValueStore. Sensitive stripping happens in
 * the runtime before save; this adapter persists exactly the envelope it gets. */
export class KeyValueDraftStorage implements DraftStorageAdapter {
  constructor(private store: KeyValueStore) {}
  async save(envelope: DraftEnvelope): Promise<void> {
    await this.store.setItem(draftKey(envelope.formId, envelope.scopeKey), JSON.stringify(envelope));
  }
  async load(formId: string, scopeKey: string): Promise<DraftEnvelope | null> {
    const raw = await this.store.getItem(draftKey(formId, scopeKey));
    if (!raw) return null;
    const e = JSON.parse(raw) as DraftEnvelope;
    if (e.expiresAt && Date.parse(e.expiresAt) < Date.now()) { await this.clear(formId, scopeKey); return null; }
    return e;
  }
  async clear(formId: string, scopeKey: string): Promise<void> {
    await this.store.removeItem(draftKey(formId, scopeKey));
  }
}

/** Durable offline queue over any KeyValueStore. Maintains per-scope and global
 * indexes so hosts do not need key enumeration. Single-device queue; not a
 * distributed lock. */
export class KeyValueOfflineQueue implements OfflineQueueAdapter {
  constructor(private store: KeyValueStore) {}
  private async index(scopeKey: string): Promise<string[]> {
    const raw = await this.store.getItem(queueIndexKey(scopeKey));
    return raw ? JSON.parse(raw) as string[] : [];
  }
  private async globalIndex(): Promise<Record<string, string>> {
    const raw = await this.store.getItem(queueGlobalIndexKey);
    return raw ? JSON.parse(raw) as Record<string, string> : {};
  }
  async enqueue(record: QueuedSubmissionRecord): Promise<void> {
    const ids = await this.index(record.scopeKey);
    for (const id of ids) {
      const raw = await this.store.getItem(queueKey(record.scopeKey, id));
      if (!raw) continue;
      const r = JSON.parse(raw) as QueuedSubmissionRecord;
      if (r.idempotencyKey === record.idempotencyKey && r.status !== 'sent' && r.status !== 'cancelled') {
        throw new Error(`QUEUE_DUPLICATE: idempotency key already queued (${record.idempotencyKey}).`);
      }
    }
    await this.store.setItem(queueKey(record.scopeKey, record.id), JSON.stringify(record));
    await this.store.setItem(queueIndexKey(record.scopeKey), JSON.stringify([...ids, record.id]));
    const global = await this.globalIndex();
    global[record.id] = record.scopeKey;
    await this.store.setItem(queueGlobalIndexKey, JSON.stringify(global));
  }
  async list(scopeKey: string): Promise<QueuedSubmissionRecord[]> {
    const ids = await this.index(scopeKey);
    const out: QueuedSubmissionRecord[] = [];
    for (const id of ids) {
      const raw = await this.store.getItem(queueKey(scopeKey, id));
      if (raw) out.push(JSON.parse(raw) as QueuedSubmissionRecord);
    }
    return out;
  }
  async update(id: string, patch: Partial<QueuedSubmissionRecord>): Promise<void> {
    const global = await this.globalIndex();
    const scopeKey = global[id];
    if (!scopeKey) throw new Error(`QUEUE_RECORD_NOT_FOUND: ${id}`);
    const raw = await this.store.getItem(queueKey(scopeKey, id));
    if (!raw) throw new Error(`QUEUE_RECORD_NOT_FOUND: ${id}`);
    const r = JSON.parse(raw) as QueuedSubmissionRecord;
    await this.store.setItem(queueKey(scopeKey, id), JSON.stringify({ ...r, ...patch, id: r.id, scopeKey: r.scopeKey }));
  }
  async remove(id: string): Promise<void> {
    const global = await this.globalIndex();
    const scopeKey = global[id];
    if (!scopeKey) return;
    await this.store.removeItem(queueKey(scopeKey, id));
    const ids = await this.index(scopeKey);
    await this.store.setItem(queueIndexKey(scopeKey), JSON.stringify(ids.filter((x) => x !== id)));
    delete global[id];
    await this.store.setItem(queueGlobalIndexKey, JSON.stringify(global));
  }
}

/** Browser localStorage adapter. Durable across page reloads; NOT secure storage.
 * Sensitive fields must remain excluded (runtime default). */
export function createLocalStorageKeyValueStore(storage: Storage = globalThis.localStorage): KeyValueStore {
  return {
    async getItem(key: string) { return storage.getItem(key); },
    async setItem(key: string, value: string) { storage.setItem(key, value); },
    async removeItem(key: string) { storage.removeItem(key); },
  };
}

export interface ExpoAsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export interface ExpoSecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Expo AsyncStorage adapter (host injects @react-native-async-storage/async-storage). */
export function createExpoAsyncStorageKeyValueStore(module: ExpoAsyncStorageLike): KeyValueStore {
  return {
    getItem: (key: string) => module.getItem(key),
    setItem: (key: string, value: string) => module.setItem(key, value),
    removeItem: (key: string) => module.removeItem(key),
  };
}

/** Expo SecureStore adapter (host injects expo-secure-store). Prefer this when
 * offline.includeSensitive is explicitly enabled. */
export function createExpoSecureStoreKeyValueStore(module: ExpoSecureStoreLike): KeyValueStore {
  return {
    getItem: (key: string) => module.getItemAsync(key),
    setItem: (key: string, value: string) => module.setItemAsync(key, value),
    removeItem: (key: string) => module.deleteItemAsync(key),
  };
}
