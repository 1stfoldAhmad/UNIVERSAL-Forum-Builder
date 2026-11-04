import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KeyValueDraftStorage, KeyValueOfflineQueue, createLocalStorageKeyValueStore,
  createExpoAsyncStorageKeyValueStore, createExpoSecureStoreKeyValueStore, type KeyValueStore,
} from '../src/index';
import type { DraftEnvelope, QueuedSubmissionRecord } from '@vds-form/types';

/** File-backed KeyValueStore used to prove adapter restart durability in tests. */
class FileKeyValueStore implements KeyValueStore {
  constructor(private path: string) {}
  private read(): Record<string, string> {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  }
  async getItem(key: string) { return this.read()[key] ?? null; }
  async setItem(key: string, value: string) { const data = this.read(); data[key] = value; writeFileSync(this.path, JSON.stringify(data)); }
  async removeItem(key: string) { const data = this.read(); delete data[key]; writeFileSync(this.path, JSON.stringify(data)); }
}

const envelope: DraftEnvelope = {
  envelopeVersion: 1, formId: 'contact', formVersion: '1.0.0', specVersion: '1.0.0',
  scopeKey: 'device:test', values: { name: 'Ada' }, savedAt: new Date().toISOString(),
};
const record: QueuedSubmissionRecord = {
  id: 'q1', operationRef: 'test:contact.create', formId: 'contact', formVersion: '1.0.0', specVersion: '1.0.0',
  scopeKey: 'device:test', values: { name: 'Ada' }, idempotencyKey: 'k1', createdAt: new Date().toISOString(),
  status: 'queued', attempts: 0, maxAttempts: 5,
};

describe('durable KeyValue persistence adapters', () => {
  it('draft storage survives adapter restart over a durable store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-kv-'));
    const path = join(dir, 'kv.json');
    const a = new KeyValueDraftStorage(new FileKeyValueStore(path));
    await a.save(envelope);
    const b = new KeyValueDraftStorage(new FileKeyValueStore(path));
    expect(await b.load('contact', 'device:test')).toEqual(envelope);
    await b.clear('contact', 'device:test');
    expect(await new KeyValueDraftStorage(new FileKeyValueStore(path)).load('contact', 'device:test')).toBeNull();
  });

  it('offline queue survives adapter restart, updates, removes, and rejects duplicates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-kv-'));
    const path = join(dir, 'kv.json');
    const a = new KeyValueOfflineQueue(new FileKeyValueStore(path));
    await a.enqueue(record);
    await expect(a.enqueue({ ...record, id: 'q2' })).rejects.toThrow('QUEUE_DUPLICATE');
    const b = new KeyValueOfflineQueue(new FileKeyValueStore(path));
    expect(await b.list('device:test')).toEqual([record]);
    await b.update('q1', { status: 'failed', attempts: 1 });
    expect((await b.list('device:test'))[0].status).toBe('failed');
    await b.remove('q1');
    expect(await new KeyValueOfflineQueue(new FileKeyValueStore(path)).list('device:test')).toEqual([]);
  });

  it('browser and Expo wrappers delegate to host storage modules', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } } as Storage;
    const local = createLocalStorageKeyValueStore(storage);
    await local.setItem('a', '1');
    expect(await local.getItem('a')).toBe('1');
    const asyncStorage = { getItem: async (k: string) => data.get(k) ?? null, setItem: async (k: string, v: string) => { data.set(k, v); }, removeItem: async (k: string) => { data.delete(k); } };
    const expo = createExpoAsyncStorageKeyValueStore(asyncStorage);
    await expo.setItem('b', '2');
    expect(await expo.getItem('b')).toBe('2');
    const secure = { getItemAsync: async (k: string) => data.get(k) ?? null, setItemAsync: async (k: string, v: string) => { data.set(k, v); }, deleteItemAsync: async (k: string) => { data.delete(k); } };
    const sec = createExpoSecureStoreKeyValueStore(secure);
    await sec.setItem('c', '3');
    expect(await sec.getItem('c')).toBe('3');
    await sec.removeItem('c');
    expect(await sec.getItem('c')).toBeNull();
  });
});
