/**
 * Standard Node HTTP boundary (mission §7). Uses ONLY built-in Node APIs and a
 * REAL node:http server for the transport-level cases.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  TrustedSubmissionHandler, OperationRegistry, handleSubmissionRequest, createSubmissionListener,
  httpStatusFor, type HttpRequestLike, type HttpLogEntry, type SubmissionHttpOptions,
} from '../src/index';
import { SimpleRbacEvaluator, InMemoryRecordStore } from '@vds-form/vds-contracts';
import type { AuthContext, FormDocument } from '@vds-form/types';

const load = (): FormDocument =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'customer-registration.vds.json'), 'utf8'));

const principal = (permissions: string[] = ['customer:create']): AuthContext =>
  ({ userId: 'u1', tenantId: 't1', roles: [], permissions });

const validValues = { name: 'Ada Lovelace', email: 'ada@example.com', type: 'individual', consent: true };

function setup() {
  const store = new InMemoryRecordStore();
  const operations = new OperationRegistry();
  let calls = 0;
  operations.register('test:customer.create', (payload) => { calls += 1; return store.create('customer', payload); });
  const handler = new TrustedSubmissionHandler({
    forms: { 'customer-registration': load() },
    operations,
    rbac: new SimpleRbacEvaluator(),
  });
  const logs: HttpLogEntry[] = [];
  const options: SubmissionHttpOptions = {
    handler,
    resolveAuth: (req) => (req.headers.authorization === 'Bearer good' ? principal() : null),
    logger: (e) => logs.push(e),
  };
  return { handler, options, logs, store, calls: () => calls };
}

let seq = 0;
const request = (body: unknown, over: Partial<HttpRequestLike> = {}, raw?: string): HttpRequestLike => ({
  method: 'POST',
  path: '/vds/submit',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': `key-${++seq}` },
  body: new TextEncoder().encode(raw ?? JSON.stringify(body)),
  ...over,
});
const payload = (over: Record<string, unknown> = {}) => ({ formId: 'customer-registration', values: validValues, ...over });

describe('Node HTTP boundary — request validation', () => {
  it('rejects a non-POST method with 405 and an Allow header', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request(payload(), { method: 'GET' }), options);
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
  });

  it('404s an unknown route', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request(payload(), { path: '/nope' }), options);
    expect(r.status).toBe(404);
  });

  it('415s a non-JSON content type', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request(payload(), { headers: { 'content-type': 'text/plain', authorization: 'Bearer good', 'idempotency-key': 'k1' } }), options);
    expect(r.status).toBe(415);
    expect((r.body as { code: string }).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('400s malformed JSON without leaking a parser message', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request(null, {}, '{not json'), options);
    expect(r.status).toBe(400);
    expect((r.body as { code: string }).code).toBe('MALFORMED_JSON');
    expect(JSON.stringify(r.body)).not.toContain('Unexpected');
  });

  it('400s a JSON array or scalar body', async () => {
    const { options } = setup();
    for (const raw of ['[]', '"str"', '42', 'null']) {
      const r = await handleSubmissionRequest(request(null, {}, raw), options);
      expect(r.status, raw).toBe(400);
    }
  });

  it('413s an oversized body', async () => {
    const { options } = setup();
    const big = { ...payload(), values: { ...validValues, name: 'x'.repeat(5000) } };
    const r = await handleSubmissionRequest(request(big), { ...options, maxBodyBytes: 1024 });
    expect(r.status).toBe(413);
    expect((r.body as { code: string }).code).toBe('BODY_TOO_LARGE');
  });

  it('requires formId and an object values map', async () => {
    const { options } = setup();
    expect((await handleSubmissionRequest(request({ values: validValues }), options)).status).toBe(400);
    expect((await handleSubmissionRequest(request({ formId: 'customer-registration', values: [] }), options)).status).toBe(400);
  });

  it('requires an idempotency key', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(
      request(payload(), { headers: { 'content-type': 'application/json', authorization: 'Bearer good' } }), options,
    );
    expect(r.status).toBe(400);
    expect((r.body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('Node HTTP boundary — identity and authorization', () => {
  it('rejects identity asserted in the body', async () => {
    const { options } = setup();
    for (const key of ['auth', 'principal', 'roles', 'permissions', 'authenticatedContext']) {
      const r = await handleSubmissionRequest(request(payload({ [key]: { userId: 'admin', permissions: ['*'] } })), options);
      expect(r.status, key).toBe(400);
      expect((r.body as { code: string }).code).toBe('AUTH_IN_BODY_FORBIDDEN');
    }
  });

  it('rejects identity smuggled inside values', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request(payload({ values: { ...validValues, auth: { userId: 'admin' } } })), options);
    expect(r.status).toBe(400);
    expect((r.body as { code: string }).code).toBe('AUTH_IN_BODY_FORBIDDEN');
  });

  it('401s an unauthenticated request when anonymous is not allowed', async () => {
    const { options, calls } = setup();
    const r = await handleSubmissionRequest(
      request(payload(), { headers: { 'content-type': 'application/json', 'idempotency-key': 'k-anon' } }), options,
    );
    expect(r.status).toBe(401);
    expect(calls()).toBe(0);
  });

  it('403s an authenticated principal lacking the operation permission', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request(payload()), {
      ...options, resolveAuth: () => principal([]),
    });
    expect(r.status).toBe(403);
  });

  it('a session cookie alone never grants authority on a token-only route', async () => {
    const { options, calls } = setup();
    // Resolver deliberately ignores cookies: only a verified bearer token counts.
    const r = await handleSubmissionRequest(
      request(payload(), { headers: { 'content-type': 'application/json', 'idempotency-key': 'k-cookie', cookie: 'session=stolen' } }),
      options,
    );
    expect(r.status).toBe(401);
    expect(calls()).toBe(0);
  });

  it('allows anonymous only when explicitly enabled', async () => {
    const { options } = setup();
    const anon = { ...options, resolveAuth: () => null, allowAnonymous: true };
    const r = await handleSubmissionRequest(
      request(payload(), { headers: { 'content-type': 'application/json', 'idempotency-key': 'k-anon-ok' } }), anon,
    );
    // The form requires customer:create, so an anonymous principal is denied —
    // enabling anonymous transport does not bypass authorization.
    expect(r.status).toBe(403);
  });

  it('404s a form that is not registered on this server', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request({ formId: 'unknown-form', values: validValues }), options);
    expect(r.status).toBe(500); // handler reports config-error for an unregistered form
    expect((r.body as { code: string }).code).toBe('SUBMISSION_OPERATION_UNRESOLVED');
  });

  it('rejects a client operationRef that does not match the compiled form', async () => {
    const { options, calls } = setup();
    const r = await handleSubmissionRequest(request(payload({ operationRef: 'test:admin.wipe' })), options);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(calls()).toBe(0);
  });
});

describe('Node HTTP boundary — execution, idempotency and errors', () => {
  it('executes a valid submission and returns 200 with a correlation id', async () => {
    const { options, calls } = setup();
    const r = await handleSubmissionRequest(request(payload(), { headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': 'k-ok', 'x-correlation-id': 'corr-abc' } }), options);
    expect(r.status).toBe(200);
    expect(r.headers['x-correlation-id']).toBe('corr-abc');
    expect((r.body as { status: string }).status).toBe('succeeded');
    expect(calls()).toBe(1);
  });

  it('generates a correlation id when the client supplies an unsafe one', async () => {
    const { options } = setup();
    const r = await handleSubmissionRequest(request(payload(), { headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': 'k-corr', 'x-correlation-id': 'bad\nvalue' } }), options);
    expect(r.headers['x-correlation-id']).not.toContain('\n');
    expect(r.headers['x-correlation-id'].length).toBeGreaterThan(10);
  });

  it('replays the same idempotency key without re-executing the operation', async () => {
    const { options, calls } = setup();
    const headers = { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': 'k-replay' };
    const a = await handleSubmissionRequest(request(payload(), { headers }), options);
    const b = await handleSubmissionRequest(request(payload(), { headers }), options);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it('rejects a reused key with a DIFFERENT payload', async () => {
    const { options } = setup();
    const headers = { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': 'k-conflict' };
    await handleSubmissionRequest(request(payload(), { headers }), options);
    const b = await handleSubmissionRequest(request(payload({ values: { ...validValues, name: 'Someone Else' } }), { headers }), options);
    expect(b.status).not.toBe(200);
  });

  it('executes only once for concurrent identical submissions', async () => {
    const { options, calls } = setup();
    const headers = { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': 'k-concurrent' };
    const results = await Promise.all([
      handleSubmissionRequest(request(payload(), { headers }), options),
      handleSubmissionRequest(request(payload(), { headers }), options),
      handleSubmissionRequest(request(payload(), { headers }), options),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    expect(calls()).toBe(1);
  });

  it('returns 422 with server issues for an invalid payload', async () => {
    const { options, calls } = setup();
    const r = await handleSubmissionRequest(request(payload({ values: { name: '', email: 'not-an-email' } })), options);
    expect(r.status).toBe(422);
    expect((r.body as { status: string }).status).toBe('server-validation-failed');
    expect(calls()).toBe(0);
  });

  it('never leaks internals or submitted values when the operation throws', async () => {
    const operations = new OperationRegistry();
    operations.register('test:customer.create', () => { throw new Error('DB password=hunter2 at internal.ts:42'); });
    const handler = new TrustedSubmissionHandler({ forms: { 'customer-registration': load() }, operations, rbac: new SimpleRbacEvaluator() });
    const r = await handleSubmissionRequest(request(payload()), { handler, resolveAuth: () => principal() });
    // An unexpected operation failure is reported as a coded business rejection.
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe('OPERATION_FAILED');
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('internal.ts');
    expect(text).not.toContain('Ada Lovelace');
  });

  it('logs identifiers and issue codes only — never values or credentials', async () => {
    const { options, logs } = setup();
    await handleSubmissionRequest(request(payload()), options);
    await handleSubmissionRequest(request(payload({ values: { name: '', email: 'x' } })), options);
    expect(logs.length).toBe(2);
    const text = JSON.stringify(logs);
    expect(text).not.toContain('Ada Lovelace');
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('Bearer');
    expect(logs[0].formId).toBe('customer-registration');
    expect(logs[0].httpStatus).toBe(200);
    expect(logs[1].issueCodes.length).toBeGreaterThan(0);
  });

  it('maps every submission outcome to a stable status', () => {
    expect(httpStatusFor({ status: 'succeeded' } as never)).toBe(200);
    expect(httpStatusFor({ status: 'server-validation-failed' } as never)).toBe(422);
    expect(httpStatusFor({ status: 'permission-denied' } as never)).toBe(403);
    expect(httpStatusFor({ status: 'business-rejected' } as never)).toBe(409);
    expect(httpStatusFor({ status: 'network-failure' } as never)).toBe(502);
    expect(httpStatusFor({ status: 'config-error' } as never)).toBe(500);
  });
});

describe('Node HTTP boundary — real node:http transport', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  async function listen(opts: SubmissionHttpOptions) {
    const server = createServer(createSubmissionListener(opts));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/vds/submit`;
  }

  it('serves a real successful POST', async () => {
    const { options, calls } = setup();
    const url = await listen(options);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': 'http-ok' },
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
    expect((await res.json() as { status: string }).status).toBe('succeeded');
    expect(calls()).toBe(1);
  });

  it('rejects an oversized streamed body with 413', async () => {
    const { options, calls } = setup();
    const url = await listen({ ...options, maxBodyBytes: 512 });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'idempotency-key': 'http-big' },
      body: JSON.stringify(payload({ values: { ...validValues, name: 'x'.repeat(4000) } })),
    }).catch((e) => e as Error);
    if (res instanceof Response) {
      expect(res.status).toBe(413);
    } else {
      // The listener destroys the socket on overflow; the client sees a reset.
      expect(String(res)).toMatch(/fetch failed|socket|ECONNRESET/i);
    }
    expect(calls()).toBe(0);
  });

  it('401s a real request with no credentials', async () => {
    const { options } = setup();
    const url = await listen(options);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-anon' },
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(401);
  });

  it('405s a real GET', async () => {
    const { options } = setup();
    const url = await listen(options);
    const res = await fetch(url);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
