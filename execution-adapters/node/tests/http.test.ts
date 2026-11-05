import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeHttpServer, OperationRegistry, TrustedSubmissionHandler } from '../src/index';
import { SimpleRbacEvaluator, InMemoryRecordStore } from '@vds-form/vds-contracts';
import type { AuthContext, FormDocument } from '@vds-form/types';
import type { Server } from 'node:http';

const form: FormDocument = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'customer-registration.vds.json'), 'utf8'));
const principal: AuthContext = { userId: 'http-user', tenantId: 'http-tenant', roles: [], permissions: ['customer:create'] };
const operations = new OperationRegistry();
const store = new InMemoryRecordStore();
operations.register('test:customer.create', (payload) => store.create('customer', payload));
const handler = new TrustedSubmissionHandler({ forms: { 'customer-registration': form }, operations, rbac: new SimpleRbacEvaluator() });
let server: Server;
async function listen(options: Partial<Parameters<typeof createNodeHttpServer>[0]> = {}) {
  server = createNodeHttpServer({ handler, ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => { if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });
const values = { name: 'HTTP User', email: 'http@example.com', type: 'individual', consent: true };

describe('built-in Node HTTP boundary', () => {
  it('enforces method/type, rejects body auth, validates and executes with server identity', async () => {
    const resolveAuth = vi.fn(() => principal);
    const base = await listen({ resolveAuth });
    expect((await fetch(base + '/forms/submit')).status).toBe(405);
    expect((await fetch(base + '/forms/submit', { method: 'POST', body: '{}' })).status).toBe(415);
    const forged = await fetch(base + '/forms/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auth: principal }) });
    expect(forged.status).toBe(400);
    expect((await forged.json()).code).toBe('AUTH_IN_BODY_FORBIDDEN');
    const response = await fetch(base + '/forms/submit', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'test:corr-1' },
      body: JSON.stringify({ formId: 'customer-registration', values, idempotencyKey: 'http-key-1' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe('test:corr-1');
    expect((await response.json()).status).toBe('succeeded');
    const replay = await fetch(base + '/forms/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'customer-registration', values, idempotencyKey: 'http-key-1' }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe('succeeded');
    expect(resolveAuth).toHaveBeenCalledTimes(2); // rejected body auth is never resolved
    expect(store.list('customer')).toHaveLength(1);
  });

  it('bounds request size and rejects malformed JSON without leaking parser details', async () => {
    const base = await listen({ maxBodyBytes: 32 });
    const tooLarge = await fetch(base + '/forms/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(40) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    const malformed = await fetch(base + '/forms/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'JSON_INVALID', message: 'Request body is invalid.' });
  });
});
