import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TrustedSubmissionHandler, OperationRegistry, createNodeExecutor, type AuditEntry } from '../src/index';
import { SimpleRbacEvaluator, InMemoryRecordStore, authContextFromClaims } from '@vds-form/vds-contracts';
import { FormController } from '@vds-form/runtime';
import { compileForm } from '@vds-form/compiler';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import type { AuthContext, FormDocument } from '@vds-form/types';

const load = (name = 'customer-registration.vds.json'): FormDocument => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const auth = (permissions: string[]): AuthContext => ({ userId: 'u1', tenantId: 't1', roles: [], permissions });

function setup(formName = 'customer-registration.vds.json') {
  const store = new InMemoryRecordStore();
  const operations = new OperationRegistry();
  operations.register('test:customer.create', (payload) => store.create('customer', payload));
  const audit: AuditEntry[] = [];
  const handler = new TrustedSubmissionHandler({
    forms: { 'customer-registration': load(formName) },
    operations,
    rbac: new SimpleRbacEvaluator(),
    audit: (e) => audit.push(e),
  });
  return { store, operations, audit, handler };
}

// Test convenience: build a combined {request, auth} object, then split it so
// auth is passed as the trusted second argument (never inside the request).
const req = (values: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  formId: 'customer-registration',
  values,
  auth: auth(['customer:create']),
  idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
  correlationId: 'corr-1',
  ...over,
});
const send = (handler: TrustedSubmissionHandler, combined: Record<string, unknown>) => {
  const { auth: a, ...request } = combined;
  return handler.handle(request as never, a as AuthContext | undefined);
};

const validPayload = {
  name: 'Ada Lovelace', email: 'ada@example.com', type: 'individual', consent: true,
};

describe('trusted Node execution adapter', () => {
  it('executes a registered operation and persists a real record', async () => {
    const { handler, store } = setup();
    const r = await send(handler, req(validPayload));
    expect(r.status).toBe('succeeded');
    expect(store.list('customer').length).toBe(1);
    expect(store.list('customer')[0]).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });

  it('re-validates server-side: missing required fields rejected even if client skipped', async () => {
    const { handler, store } = setup();
    const r = await send(handler, req({ name: 'Ada' }));
    expect(r.status).toBe('server-validation-failed');
    if (r.status === 'server-validation-failed') {
      expect(r.issues.every((i) => i.source === 'server')).toBe(true);
      expect(r.issues.some((i) => i.code === 'REQUIRED')).toBe(true);
    }
    expect(store.list('customer').length).toBe(0);
  });

  it('enforces conditional required rules identically to the client', async () => {
    const { handler } = setup();
    const r = await send(handler, req({ ...validPayload, type: 'business' }));
    expect(r.status).toBe('server-validation-failed');
    if (r.status === 'server-validation-failed') {
      expect(r.issues.some((i) => i.path === 'customer.companyName' && i.code === 'REQUIRED')).toBe(true);
    }
    const ok = await send(handler, req({ ...validPayload, type: 'business', companyName: 'Analytical Engines Ltd' }));
    expect(ok.status).toBe('succeeded');
  });

  it('denies submission without required permissions (fail closed)', async () => {
    const { handler, store } = setup();
    const r = await send(handler, req(validPayload, { auth: auth([]) }));
    expect(r).toMatchObject({ status: 'permission-denied', code: 'PERMISSION_DENIED' });
    expect(store.list('customer').length).toBe(0);
  });

  it('fails closed when permissions declared but no RBAC evaluator registered', async () => {
    const operations = new OperationRegistry();
    operations.register('test:customer.create', () => ({}));
    const handler = new TrustedSubmissionHandler({ forms: { 'customer-registration': load() }, operations });
    const r = await send(handler, req(validPayload));
    expect(r).toMatchObject({ status: 'permission-denied', code: 'RBAC_NOT_CONFIGURED' });
  });

  it('enforces field-level write access', async () => {
    const doc = load('purchase-approval.vds.json');
    const operations = new OperationRegistry();
    operations.register('test:purchase.create', (p) => p);
    const handler = new TrustedSubmissionHandler({
      forms: { 'purchase-approval': doc }, operations, rbac: new SimpleRbacEvaluator(),
    });
    const r = await send(handler, {
      formId: 'purchase-approval',
      values: { request: { item: 'Laptop', amount: 1500, department: 'eng', justification: 'Required for new hire onboarding process.' } },
      auth: auth([]), idempotencyKey: 'k1', correlationId: 'c1',
    });
    expect(r.status).toBe('permission-denied');
  });

  it('idempotent replay returns the recorded result without re-execution', async () => {
    const { handler, store } = setup();
    const r1 = await send(handler, req(validPayload, { idempotencyKey: 'fixed-key' }));
    const r2 = await send(handler, req(validPayload, { idempotencyKey: 'fixed-key' }));
    expect(r1.status).toBe('succeeded');
    expect(r2).toEqual(r1);
    expect(store.list('customer').length).toBe(1); // not duplicated
  });

  it('unknown operations and forms fail explicitly', async () => {
    const { handler } = setup();
    const r = await send(handler, req(validPayload, { operationRef: 'test:not.registered' }));
    expect(r).toMatchObject({ status: 'permission-denied', code: 'OPERATION_OVERRIDE_FORBIDDEN' });
    const r2 = await send(handler, req(validPayload, { formId: 'ghost-form' }));
    expect(r2.status).toBe('config-error');
  });

  it('rejects outdated form versions', async () => {
    const { handler } = setup();
    const r = await send(handler, req(validPayload, { formVersion: '0.0.1' }));
    expect(r.status).toBe('server-validation-failed');
    if (r.status === 'server-validation-failed') expect(r.issues[0].code).toBe('FORM_VERSION_MISMATCH');
  });

  it('audit entries never contain submitted values', async () => {
    const { handler, audit } = setup();
    await send(handler, req(validPayload));
    expect(audit.length).toBe(1);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('Ada Lovelace');
    expect(serialized).not.toContain('ada@example.com');
    expect(audit[0].valuePaths).toEqual(['name', 'email', 'type', 'consent']);
    expect(audit[0].outcome).toBe('succeeded');
  });

  it('operation business errors normalize to business-rejected', async () => {
    const operations = new OperationRegistry();
    operations.register('test:customer.create', () => { throw { code: 'DUPLICATE_EMAIL', message: 'Email already exists.' }; });
    const handler = new TrustedSubmissionHandler({ forms: { 'customer-registration': load() }, operations, rbac: new SimpleRbacEvaluator() });
    const r = await send(handler, req(validPayload));
    expect(r).toMatchObject({ status: 'business-rejected', code: 'DUPLICATE_EMAIL' });
  });

  it('authContextFromClaims maps expo-app-foundation session claims', () => {
    const ctx = authContextFromClaims({ sub: 'u9', tenant_id: 't3', roles: ['reviewer'], permissions: ['purchase:approve'], sid: 's1' });
    expect(ctx).toEqual({ userId: 'u9', tenantId: 't3', roles: ['reviewer'], permissions: ['purchase:approve'], sessionId: 's1' });
  });
});

describe('end-to-end: headless runtime → trusted Node adapter', () => {
  it('full client lifecycle executes through the server handler with re-validation', async () => {
    const { handler, store, audit } = setup();
    const compiled = compileForm(load());
    if (!compiled.ok) throw new Error('compile');
    const executors = new SubmissionExecutorRegistry();
    executors.register(createNodeExecutor(handler, 'test', { auth: auth(['customer:create']) }));
    const controller = new FormController({
      ir: compiled.ir, executors,
      auth: auth(['customer:create']),
      rbac: new SimpleRbacEvaluator(),
    });
    await controller.initialize();
    controller.setFieldValue('customer.name', 'Grace Hopper');
    controller.setFieldValue('customer.email', 'grace@example.com');
    controller.setFieldValue('customer.consent', true);
    const result = await controller.submit();
    expect(result.status).toBe('succeeded');
    expect(store.findBy('customer', 'email', 'grace@example.com')).toBeTruthy();
    expect(audit.some((a) => a.outcome === 'succeeded')).toBe(true);
    controller.dispose();
  });
});
