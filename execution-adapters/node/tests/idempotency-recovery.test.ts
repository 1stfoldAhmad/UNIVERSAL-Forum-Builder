import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { InMemoryIdempotencyStore, SqliteIdempotencyStore, type IdempotencyStore } from '../src/idempotency';
import { TrustedSubmissionHandler, OperationRegistry } from '../src/index';
import type { FormDocument, SubmissionResult } from '@vds-form/types';

const result: SubmissionResult = { status: 'succeeded', operationRef: 'test:contact.create', data: { id: 'r1' }, idempotencyKey: 'k', durationMs: 1 };

describe('idempotency lease recovery', () => {
  it('in-memory claims carry timestamps, expire safely, and never auto-re-execute', () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim('k', 'fp', { now: 1000, leaseMs: 1000 })).toEqual({ kind: 'claimed' });
    expect(store.claim('k', 'fp', { now: 1500, leaseMs: 1000 })).toEqual({ kind: 'in-progress' });
    expect(store.claim('k', 'other', { now: 1500 })).toEqual({ kind: 'conflict' });
    expect(store.claim('k', 'fp', { now: 2001, leaseMs: 1000 })).toEqual({ kind: 'expired', claimedAt: 1000, leaseExpiresAt: 2000 });
    // Host reconciles: committed → complete → replay; not committed → release → reclaim.
    store.complete('k', result);
    expect(store.claim('k', 'fp', { now: 3000 })).toEqual({ kind: 'replay', result });
    store.release('k'); // no-op for complete
    expect(store.claim('k', 'fp', { now: 3000 })).toEqual({ kind: 'replay', result });
  });

  it('release allows retry only for in-progress claims', () => {
    const store = new InMemoryIdempotencyStore();
    store.claim('k', 'fp', { now: 1000, leaseMs: 1000 });
    store.release('k');
    expect(store.claim('k', 'fp', { now: 1100, leaseMs: 1000 })).toEqual({ kind: 'claimed' });
  });

  it('SQLite claims survive restart and expire without duplicate execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-idem-'));
    const path = join(dir, 'idem.sqlite');
    const a = new SqliteIdempotencyStore(path);
    expect(a.claim('k', 'fp', { now: 1000, leaseMs: 1000 })).toEqual({ kind: 'claimed' });
    a.close();
    const b = new SqliteIdempotencyStore(path);
    expect(b.claim('k', 'fp', { now: 1500, leaseMs: 1000 })).toEqual({ kind: 'in-progress' });
    expect(b.claim('k', 'fp', { now: 2001, leaseMs: 1000 })).toEqual({ kind: 'expired', claimedAt: 1000, leaseExpiresAt: 2000 });
    expect(b.claim('k', 'other', { now: 2001 })).toEqual({ kind: 'conflict' });
    b.complete('k', result);
    b.close();
    const c = new SqliteIdempotencyStore(path);
    expect(c.claim('k', 'fp', { now: 9999 })).toEqual({ kind: 'replay', result });
    c.close();
  });

  it('trusted handler maps expired claims to recovery-required and does not execute', async () => {
    const doc: FormDocument = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'contact.vds.json'), 'utf8'));
    const operations = new OperationRegistry();
    let calls = 0;
    operations.register('test:contact.create', () => { calls++; return { id: 'x' }; });
    const expiredStore: IdempotencyStore = {
      claim: () => ({ kind: 'expired', claimedAt: 1, leaseExpiresAt: 2 }),
      complete: () => {},
      release: () => {},
    };
    const handler = new TrustedSubmissionHandler({ forms: { contact: doc }, operations, idempotencyStore: expiredStore });
    const r = await handler.handle({ formId: 'contact', values: { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hello from the recovery test.' }, idempotencyKey: 'k', correlationId: 'c' }, undefined);
    expect(r.status).toBe('business-rejected');
    if (r.status === 'business-rejected') expect(r.code).toBe('IDEMPOTENCY_RECOVERY_REQUIRED');
    expect(calls).toBe(0);
  });
});
