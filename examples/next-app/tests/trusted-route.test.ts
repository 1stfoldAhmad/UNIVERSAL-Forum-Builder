/**
 * The trusted App Router route handler (mission §8): real HTTP boundary wiring,
 * server-derived identity, body-auth rejection and validation errors.
 */
import { describe, expect, it } from 'vitest';
import { POST } from '../app/api/submit/route';

const values = { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hello from the Next.js example.' };
let seq = 0;

function call(body: unknown, headers: Record<string, string> = {}) {
  return POST(new Request('http://localhost/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-token', 'idempotency-key': `next-${++seq}`, ...headers },
    body: JSON.stringify(body),
  }));
}

describe('Next.js example — trusted route', () => {
  it('accepts a valid submission through the trusted operation', async () => {
    const res = await call({ formId: 'contact', values });
    expect(res.status).toBe(200);
    const json = await res.json() as { status: string };
    expect(json.status).toBe('succeeded');
  });

  it('rejects a request with no server-derived identity', async () => {
    const res = await POST(new Request('http://localhost/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `next-anon-${++seq}` },
      body: JSON.stringify({ formId: 'contact', values }),
    }));
    expect(res.status).toBe(401);
  });

  it('rejects identity asserted in the body even with a valid token', async () => {
    const res = await call({ formId: 'contact', values, auth: { userId: 'admin', permissions: ['*'] } });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('AUTH_IN_BODY_FORBIDDEN');
  });

  it('returns 422 with server validation issues for an invalid payload', async () => {
    const res = await call({ formId: 'contact', values: { name: '', email: 'nope', message: '' } });
    expect(res.status).toBe(422);
    const json = await res.json() as { status: string; issues: { code: string }[] };
    expect(json.status).toBe('server-validation-failed');
    expect(json.issues.length).toBeGreaterThan(0);
  });

  it('replays an idempotency key without creating a second record', async () => {
    const key = `next-replay-${++seq}`;
    const a = await call({ formId: 'contact', values }, { 'idempotency-key': key });
    const b = await call({ formId: 'contact', values }, { 'idempotency-key': key });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ja = await a.json() as { data: { id: string } };
    const jb = await b.json() as { data: { id: string } };
    expect(jb.data.id).toBe(ja.data.id);
  });

  it('rejects an unregistered form', async () => {
    const res = await call({ formId: 'not-registered', values });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
