/**
 * Adversarial security tests for the trusted Node execution adapter.
 * These target the audit's P0/P1 findings directly:
 *  - operation selection/override by the client,
 *  - cross-principal idempotency replay and payload-swap,
 *  - concurrent double-execution,
 *  - durable idempotency across process restart,
 *  - authorization enforced BEFORE any cached replay,
 *  - client-supplied auth in the request body is never trusted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TrustedSubmissionHandler, OperationRegistry,
  InMemoryIdempotencyStore, SqliteIdempotencyStore,
  payloadFingerprint, scopedIdempotencyKey, canonicalJson,
} from '../src/index';
import { SimpleRbacEvaluator } from '@vds-form/vds-contracts';
import type { AuthContext, FormDocument } from '@vds-form/types';

const load = (name = 'customer-registration.vds.json'): FormDocument =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const auth = (userId: string, permissions: string[], tenantId = 't1'): AuthContext =>
  ({ userId, tenantId, roles: [], permissions });
const validPayload = { name: 'Ada Lovelace', email: 'ada@example.com', type: 'individual', consent: true };
const baseReq = (over: Record<string, unknown> = {}) => ({
  formId: 'customer-registration', values: validPayload,
  idempotencyKey: 'k', correlationId: 'c', ...over,
});

function setup(opts: { idempotencyStore?: InMemoryIdempotencyStore | SqliteIdempotencyStore; allowedOperations?: string[] } = {}) {
  const operations = new OperationRegistry();
  const calls: string[] = [];
  operations.register('test:customer.create', (p) => { calls.push('customer.create'); return { id: `rec-${calls.length}`, ...p }; });
  // A second, registered but privileged operation the form is NOT bound to.
  operations.register('test:admin.wipe', () => { calls.push('admin.wipe'); return { wiped: true }; });
  const handler = new TrustedSubmissionHandler({
    forms: { 'customer-registration': load() },
    operations, rbac: new SimpleRbacEvaluator(),
    idempotencyStore: opts.idempotencyStore, allowedOperations: opts.allowedOperations,
  });
  return { handler, operations, calls };
}

describe('security: operation binding (audit finding 2)', () => {
  it('rejects a client attempt to override the configured operation with another registered operation', async () => {
    const { handler, calls } = setup();
    const r = await handler.handle(baseReq({ operationRef: 'test:admin.wipe' }), auth('u1', ['customer:create', 'admin:wipe']));
    expect(r).toMatchObject({ status: 'permission-denied', code: 'OPERATION_OVERRIDE_FORBIDDEN' });
    expect(calls).toEqual([]); // the privileged operation never ran
  });

  it('executes the IR-bound operation when the client echo matches', async () => {
    const { handler, calls } = setup();
    const r = await handler.handle(baseReq({ operationRef: 'test:customer.create' }), auth('u1', ['customer:create']));
    expect(r.status).toBe('succeeded');
    expect(calls).toEqual(['customer.create']);
  });

  it('enforces a server-side operation allowlist', async () => {
    const { handler, calls } = setup({ allowedOperations: ['test:something.else'] });
    const r = await handler.handle(baseReq(), auth('u1', ['customer:create']));
    expect(r).toMatchObject({ status: 'permission-denied', code: 'OPERATION_NOT_ALLOWED' });
    expect(calls).toEqual([]);
  });
});

describe('security: idempotency isolation (audit finding 3)', () => {
  it('does not replay one user\'s cached result to a different user with the same key', async () => {
    const { handler, calls } = setup();
    const r1 = await handler.handle(baseReq(), auth('alice', ['customer:create']));
    const r2 = await handler.handle(baseReq(), auth('bob', ['customer:create']));
    expect(r1.status).toBe('succeeded');
    expect(r2.status).toBe('succeeded');
    // Both executed independently — bob did NOT receive alice's cached record.
    expect(calls).toEqual(['customer.create', 'customer.create']);
    if (r1.status === 'succeeded' && r2.status === 'succeeded') {
      expect(r1.data).not.toEqual(r2.data);
    }
  });

  it('isolates tenants even for the same user id and key', async () => {
    const { handler, calls } = setup();
    await handler.handle(baseReq(), auth('u1', ['customer:create'], 'tenant-a'));
    await handler.handle(baseReq(), auth('u1', ['customer:create'], 'tenant-b'));
    expect(calls.length).toBe(2);
  });

  it('replays within the same principal, form, operation and key', async () => {
    const { handler, calls } = setup();
    const r1 = await handler.handle(baseReq(), auth('alice', ['customer:create']));
    const r2 = await handler.handle(baseReq(), auth('alice', ['customer:create']));
    expect(r2).toEqual(r1);
    expect(calls).toEqual(['customer.create']);
  });

  it('rejects reuse of the same key with a different payload (fingerprint conflict)', async () => {
    const { handler, calls } = setup();
    const r1 = await handler.handle(baseReq(), auth('alice', ['customer:create']));
    expect(r1.status).toBe('succeeded');
    const r2 = await handler.handle(baseReq({ values: { ...validPayload, email: 'different@example.com' } }), auth('alice', ['customer:create']));
    expect(r2).toMatchObject({ status: 'business-rejected', code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(calls).toEqual(['customer.create']); // no second execution
  });

  it('prevents concurrent double-execution of the same scoped key', async () => {
    const operations = new OperationRegistry();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let executions = 0;
    operations.register('test:customer.create', async () => { executions++; await gate; return { id: 'rec-1' }; });
    const handler = new TrustedSubmissionHandler({
      forms: { 'customer-registration': load() }, operations, rbac: new SimpleRbacEvaluator(),
    });
    const a = auth('alice', ['customer:create']);
    const p1 = handler.handle(baseReq(), a);
    // Let p1 reach the (blocked) operation before p2 claims.
    await new Promise((r) => setTimeout(r, 20));
    const p2 = handler.handle(baseReq(), a);
    const r2 = await p2;
    expect(r2).toMatchObject({ status: 'business-rejected', code: 'IDEMPOTENCY_IN_PROGRESS' });
    release();
    const r1 = await p1;
    expect(r1.status).toBe('succeeded');
    expect(executions).toBe(1);
  });

  it('enforces authorization BEFORE returning a cached replay', async () => {
    const { handler, calls } = setup();
    const ok = await handler.handle(baseReq(), auth('alice', ['customer:create']));
    expect(ok.status).toBe('succeeded');
    // Same principal + key + payload, but the permission has been revoked.
    const denied = await handler.handle(baseReq(), auth('alice', []));
    expect(denied).toMatchObject({ status: 'permission-denied', code: 'PERMISSION_DENIED' });
    expect(calls).toEqual(['customer.create']); // not re-executed, and not replayed either
  });
});

describe('security: durable idempotency across restart (audit finding 3)', () => {
  it('SqliteIdempotencyStore replays a completed result after a simulated restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-idem-'));
    const dbPath = join(dir, 'idem.sqlite');
    try {
      const store1 = new SqliteIdempotencyStore(dbPath);
      const { handler: h1, calls: c1 } = setup({ idempotencyStore: store1 });
      const r1 = await h1.handle(baseReq(), auth('alice', ['customer:create']));
      expect(r1.status).toBe('succeeded');
      expect(c1).toEqual(['customer.create']);
      store1.close();

      // Simulate a process restart: a brand-new store + handler on the same file.
      const store2 = new SqliteIdempotencyStore(dbPath);
      const { handler: h2, calls: c2 } = setup({ idempotencyStore: store2 });
      const r2 = await h2.handle(baseReq(), auth('alice', ['customer:create']));
      expect(r2).toEqual(r1);
      expect(c2).toEqual([]); // replayed from durable storage, not re-executed
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('security: client-supplied auth is never trusted (audit finding 1)', () => {
  it('ignores a forged auth object smuggled into the request and uses the server principal', async () => {
    const { handler, calls } = setup();
    // The client tries to grant itself wildcard by putting auth in the request.
    const forged = { ...baseReq(), auth: { userId: 'attacker', permissions: ['*'] } };
    // The server-derived principal has NO permissions.
    const r = await handler.handle(forged as never, auth('real-user', []));
    expect(r).toMatchObject({ status: 'permission-denied', code: 'PERMISSION_DENIED' });
    expect(calls).toEqual([]);
  });
});

describe('idempotency helpers: canonical determinism', () => {
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('fingerprint changes when payload changes and is stable under key reordering', () => {
    const f1 = payloadFingerprint({ a: 1, b: 2 });
    const f2 = payloadFingerprint({ b: 2, a: 1 });
    const f3 = payloadFingerprint({ a: 1, b: 3 });
    expect(f1).toBe(f2);
    expect(f1).not.toBe(f3);
  });
  it('scoped keys differ across user, tenant, form and operation', () => {
    const base = { tenantId: 't', userId: 'u', formId: 'f', operationRef: 'op', idempotencyKey: 'k' };
    const k = scopedIdempotencyKey(base);
    expect(scopedIdempotencyKey({ ...base, userId: 'u2' })).not.toBe(k);
    expect(scopedIdempotencyKey({ ...base, tenantId: 't2' })).not.toBe(k);
    expect(scopedIdempotencyKey({ ...base, formId: 'f2' })).not.toBe(k);
    expect(scopedIdempotencyKey({ ...base, operationRef: 'op2' })).not.toBe(k);
    expect(scopedIdempotencyKey(base)).toBe(k);
  });
});
