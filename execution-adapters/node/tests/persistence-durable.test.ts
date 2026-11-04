import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDraftStorage, SqliteOfflineQueue } from '../src/persistence';
import type { DraftEnvelope, QueuedSubmissionRecord } from '@vds-form/types';

const envelope: DraftEnvelope = {
  envelopeVersion: 1, formId: 'contact', formVersion: '1.0.0', specVersion: '1.0.0',
  scopeKey: 'device:test', values: { name: 'Ada' }, savedAt: new Date().toISOString(),
};
const record: QueuedSubmissionRecord = {
  id: 'q1', operationRef: 'test:contact.create', formId: 'contact', formVersion: '1.0.0', specVersion: '1.0.0',
  scopeKey: 'device:test', values: { name: 'Ada' }, idempotencyKey: 'k1', createdAt: new Date().toISOString(),
  status: 'queued', attempts: 0, maxAttempts: 5,
};

describe('durable SQLite persistence (Node adapter)', () => {
  it('drafts survive close/reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-draft-'));
    const path = join(dir, 'drafts.sqlite');
    const a = new SqliteDraftStorage(path);
    await a.save(envelope);
    a.close();
    const b = new SqliteDraftStorage(path);
    expect(await b.load('contact', 'device:test')).toEqual(envelope);
    await b.clear('contact', 'device:test');
    expect(await b.load('contact', 'device:test')).toBeNull();
    b.close();
  });

  it('offline queue survives close/reopen, updates, removes, and rejects duplicate active keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-queue-'));
    const path = join(dir, 'queue.sqlite');
    const a = new SqliteOfflineQueue(path);
    await a.enqueue(record);
    await expect(a.enqueue({ ...record, id: 'q2' })).rejects.toThrow('QUEUE_DUPLICATE');
    a.close();
    const b = new SqliteOfflineQueue(path);
    expect(await b.list('device:test')).toEqual([record]);
    await b.update('q1', { status: 'sent', attempts: 1 });
    const after = await b.list('device:test');
    expect(after[0].status).toBe('sent');
    // sent records no longer block the same idempotency key
    await b.enqueue({ ...record, id: 'q3' });
    await b.remove('q1');
    expect((await b.list('device:test')).map((r) => r.id)).toEqual(['q3']);
    b.close();
  });
});
