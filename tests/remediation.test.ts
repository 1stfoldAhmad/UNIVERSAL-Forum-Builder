/**
 * Independent-audit remediation regressions (Stages 2–6).
 * These are adversarial, end-to-end checks in addition to the shared
 * cross-language security vectors.
 */
import { describe, expect, it } from 'vitest';
import { compileForm } from '@vds-form/compiler';
import { computeEffectiveState, collectUnknownPropertyIssues, stripPaths, hiddenTemplatePaths } from '@vds-form/validation';
import { buildSubmissionPayload, SubmissionExecutorRegistry } from '@vds-form/submission';
import { FormController } from '@vds-form/runtime';
import { PluginHost, PLUGIN_CONTRACT_VERSION } from '../packages/form-plugin-sdk/src/index';
import { createDefaultFieldRegistry } from '@vds-form/fields';
import { TrustedSubmissionHandler, OperationRegistry, createNodeExecutor } from '../execution-adapters/node/src/index';
import { SimpleRbacEvaluator } from '@vds-form/vds-contracts';
import type { AuthContext, FormDocument, PluginManifest, SubmissionExecutor, SubmissionResult } from '@vds-form/types';

const doc = (over: Partial<FormDocument> = {}): FormDocument => ({
  format: 'vds.form', specVersion: '1.0.0', id: 'remediation-form',
  metadata: { name: 'Remediation', version: '1.0.0' },
  fields: [{ id: 'name', type: 'text', key: 'name' }],
  submission: { operationRef: 'test:remediation' },
  ...over,
});
const irOf = (d: FormDocument) => {
  const r = compileForm(d);
  if (!r.ok) throw new Error(r.diagnostics.map((x) => x.message).join('; '));
  return r.ir;
};
const auth = (permissions: string[]): AuthContext => ({ userId: 'u1', tenantId: 't1', roles: [], permissions });

describe('Stage 2 — recursive hidden stripping', () => {
  it('strips hidden repeater descendants while preserving visible siblings', () => {
    const ir = irOf(doc({
      fields: [
        { id: 'items', type: 'repeater', key: 'items', children: [
          { id: 'secret', type: 'text', key: 'items[].secret', hidden: true },
          { id: 'label', type: 'text', key: 'items[].label' },
        ] },
      ],
    }));
    const values = { items: [{ secret: 'leak', label: 'a' }, { secret: 'leak2', label: 'b' }] };
    const { state } = computeEffectiveState(ir, values);
    const { payload, issues } = buildSubmissionPayload(ir, values, state, ir.submission!);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(payload).toEqual({ items: [{ label: 'a' }, { label: 'b' }] });
  });

  it('cannot reintroduce hidden descendants through a parent inputMapping', () => {
    const ir = irOf(doc({
      fields: [
        { id: 'profile', type: 'group', key: 'profile', children: [
          { id: 'secret', type: 'text', key: 'profile.secret', hidden: true },
          { id: 'name', type: 'text', key: 'profile.name' },
        ] },
      ],
      submission: { operationRef: 'test:remediation', inputMapping: { data: 'profile' } },
    }));
    const values = { profile: { secret: 'leak', name: 'visible' } };
    const { state } = computeEffectiveState(ir, values);
    const { payload } = buildSubmissionPayload(ir, values, state, ir.submission!);
    expect(payload).toEqual({ data: { name: 'visible' } });
  });

  it('normalizes multi-level nested repeater templates defensively', () => {
    const ir = { fields: [
      { id: 'secret', key: 'outer[].inner[].secret', type: 'text', valueType: 'string' },
      { id: 'name', key: 'outer[].inner[].name', type: 'text', valueType: 'string' },
    ] } as never;
    const visibility = { secret: false, name: true };
    const cleaned = stripPaths({ outer: [{ inner: [{ secret: 'leak', name: 'ok' }] }] }, hiddenTemplatePaths(ir, visibility));
    expect(cleaned).toEqual({ outer: [{ inner: [{ name: 'ok' }] }] });
  });
});

describe('Stage 3 — strict undeclared-property rejection', () => {
  const setup = (d: FormDocument) => {
    const calls: unknown[] = [];
    const operations = new OperationRegistry();
    operations.register('test:remediation', (p) => { calls.push(p); return p; });
    const handler = new TrustedSubmissionHandler({ forms: { 'remediation-form': d }, operations, rbac: new SimpleRbacEvaluator() });
    const send = (values: Record<string, unknown>) => handler.handle({ formId: 'remediation-form', values, idempotencyKey: `k-${calls.length}-${Math.random()}`, correlationId: 'c' }, auth([]));
    return { handler, calls, send };
  };

  it('rejects root mass-assignment before the operation executes', async () => {
    const { calls, send } = setup(doc());
    const r = await send({ name: 'Ada', isAdmin: true });
    expect(r.status).toBe('server-validation-failed');
    if (r.status === 'server-validation-failed') expect(r.issues.some((i) => i.code === 'UNKNOWN_PROPERTY')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('rejects nested and repeater-row undeclared properties', async () => {
    const nested = setup(doc({ fields: [{ id: 'profile', type: 'group', key: 'profile', children: [{ id: 'name', type: 'text', key: 'profile.name' }] }] }));
    const r1 = await nested.send({ profile: { name: 'Ada', role: 'admin' } });
    expect(r1.status).toBe('server-validation-failed');
    const rep = setup(doc({ fields: [{ id: 'items', type: 'repeater', key: 'items', children: [{ id: 'qty', type: 'integer', key: 'items[].qty' }] }] }));
    const r2 = await rep.send({ items: [{ qty: 1, priceOverride: 0 }] });
    expect(r2.status).toBe('server-validation-failed');
    expect(nested.calls).toEqual([]);
    expect(rep.calls).toEqual([]);
  });

  it('rejects prototype-pollution keys without mutating Object.prototype', async () => {
    const { calls, send } = setup(doc());
    const values = JSON.parse('{"name":"Ada","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const r = await send(values);
    expect(r.status).toBe('server-validation-failed');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('preserves explicitly declared typed operation inputs and rejects unknown members', async () => {
    const d = doc({ submission: { operationRef: 'test:remediation', operationInputs: { meta: { valueType: 'object', properties: { source: { valueType: 'string' } } } } } });
    const ok = setup(d);
    const r1 = await ok.send({ name: 'Ada', meta: { source: 'web' } });
    expect(r1.status).toBe('succeeded');
    expect(ok.calls[0]).toMatchObject({ name: 'Ada', meta: { source: 'web' } });
    const bad = setup(d);
    const r2 = await bad.send({ name: 'Ada', meta: { source: 'web', extra: true } });
    expect(r2.status).toBe('server-validation-failed');
    expect(bad.calls).toEqual([]);
  });

  it('shared unknown-property policy rejects constructor pollution', () => {
    const ir = irOf(doc());
    const issues = collectUnknownPropertyIssues(ir, JSON.parse('{"name":"Ada","constructor":{"prototype":{"polluted":true}}}'));
    expect(issues.some((i) => i.code === 'UNSAFE_PROPERTY')).toBe(true);
  });
});

describe('Stage 4 — field-level read authorization', () => {
  const readDoc = doc({
    fields: [
      { id: 'secret', type: 'text', key: 'secret' },
      { id: 'name', type: 'text', key: 'name' },
    ],
    security: { fieldAccess: { secret: { read: ['secret:read'] } } },
  });

  it('redacts initial values, snapshots, field slices and options fail-closed', async () => {
    const ir = irOf(readDoc);
    const controller = new FormController({ ir, initialValues: { secret: 'leak', name: 'visible' }, uiAuth: auth([]), rbac: new SimpleRbacEvaluator() });
    await controller.initialize();
    expect(controller.getValues()).toEqual({ name: 'visible' });
    expect(controller.getFieldValue('secret')).toBeNull();
    expect(controller.getSnapshot().values).toEqual({ name: 'visible' });
    expect((controller.fieldSlice('secret') as { value: unknown }).value).toBeNull();
    expect(controller.getOptions('secret')).toEqual([]);
    controller.dispose();
  });

  it('fails closed when read authorization cannot be resolved', async () => {
    const ir = irOf(readDoc);
    const controller = new FormController({ ir, initialValues: { secret: 'leak', name: 'visible' }, uiAuth: auth(['secret:read']) });
    await controller.initialize();
    expect(controller.getValues()).toEqual({ name: 'visible' });
    controller.dispose();
  });

  it('redacts unauthorized values from executor results and submission snapshots', async () => {
    const ir = irOf(readDoc);
    const executors = new SubmissionExecutorRegistry();
    const executor: SubmissionExecutor = {
      scheme: 'test', contract: { supportsOfflineQueue: false, idempotent: true, trusted: true },
      supports: () => true,
      execute: async (): Promise<SubmissionResult> => ({ status: 'succeeded', operationRef: 'test:remediation', data: { secret: 'leak', name: 'ok' }, idempotencyKey: 'k', durationMs: 1 }),
    };
    executors.register(executor);
    const controller = new FormController({ ir, executors, uiAuth: auth([]), rbac: new SimpleRbacEvaluator() });
    await controller.initialize();
    const r = await controller.submit();
    expect(r.status).toBe('succeeded');
    if (r.status === 'succeeded') expect(r.data).toEqual({ name: 'ok' });
    expect(JSON.stringify(controller.getSnapshot().submission)).not.toContain('leak');
    controller.dispose();
  });

  it('enforces field-level write protection on concrete repeater rows (including null)', async () => {
    const d = doc({
      fields: [{ id: 'items', type: 'repeater', key: 'items', children: [{ id: 'secret', type: 'text', key: 'items[].secret' }] }],
      security: { fieldAccess: { secret: { write: ['secret:write'] } } },
    });
    const operations = new OperationRegistry();
    let calls = 0;
    operations.register('test:remediation', () => { calls += 1; return {}; });
    const handler = new TrustedSubmissionHandler({ forms: { 'remediation-form': d }, operations, rbac: new SimpleRbacEvaluator() });
    const r = await handler.handle({ formId: 'remediation-form', values: { items: [{ secret: null }] }, idempotencyKey: 'k', correlationId: 'c' }, auth([]));
    expect(r).toMatchObject({ status: 'permission-denied', code: 'FIELD_WRITE_DENIED' });
    expect(calls).toBe(0);
  });

  it('re-filters idempotent replay under the current read permissions', async () => {
    const operations = new OperationRegistry();
    let calls = 0;
    operations.register('test:remediation', () => { calls += 1; return { secret: 'leak', name: 'ok' }; });
    const handler = new TrustedSubmissionHandler({ forms: { 'remediation-form': readDoc }, operations, rbac: new SimpleRbacEvaluator() });
    const request = { formId: 'remediation-form', values: { name: 'Ada' }, idempotencyKey: 'same-key', correlationId: 'c' };
    const first = await handler.handle(request, auth(['secret:read']));
    const second = await handler.handle(request, auth([]));
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    if (first.status === 'succeeded') expect(first.data).toMatchObject({ secret: 'leak' });
    if (second.status === 'succeeded') expect(second.data).toEqual({ name: 'ok' });
    expect(calls).toBe(1);
  });

  it('trusted Node handler filters read-protected operation results', async () => {
    const operations = new OperationRegistry();
    operations.register('test:remediation', () => ({ secret: 'leak', name: 'ok' }));
    const handler = new TrustedSubmissionHandler({ forms: { 'remediation-form': readDoc }, operations, rbac: new SimpleRbacEvaluator() });
    const r = await handler.handle({ formId: 'remediation-form', values: { name: 'Ada' }, idempotencyKey: 'k1', correlationId: 'c' }, auth([]));
    expect(r.status).toBe('succeeded');
    if (r.status === 'succeeded') expect(r.data).toEqual({ name: 'ok' });
  });
});

describe('Stage 5 — plugin trust boundary', () => {
  const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
    id: 'acme-plugin', version: '1.0.0', contractVersion: PLUGIN_CONTRACT_VERSION,
    targets: ['*'], provides: [], trust: 'trusted', ...over,
  });

  it('rejects sandboxed and untrusted manifests without side effects', () => {
    const fields = createDefaultFieldRegistry();
    const host = new PluginHost({ fields });
    const before = fields.size;
    const r = host.register(manifest({ trust: 'sandboxed', provides: [{ kind: 'field', name: 'acme-x' }] }), { fields: [{ type: 'acme-x', valueType: 'string', emptyValue: null, accepts: ['string', 'null'], capability: { fieldType: 'acme-x', contractVersion: '1.0.0', valueType: 'string', supportsValidation: true, supportsAsyncValidation: true, supportsAccessibility: true, supportsLocalization: true, supportsReadonly: true, supportsDisabled: true, supportsDynamicOptions: false, requiresNativeModule: false } }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'PLUGIN_SANDBOX_UNSUPPORTED' } });
    expect(fields.size).toBe(before);
    expect(host.register(manifest({ id: 'untrusted-plugin', trust: 'untrusted' }))).toMatchObject({ ok: false, error: { code: 'PLUGIN_SANDBOX_UNSUPPORTED' } });
  });

  it('enforces per-plugin grants and immutable manifest copies', () => {
    const host = new PluginHost({ grantedPermissions: ['global:perm'], pluginPermissions: { 'acme-plugin': ['scoped:perm'] } });
    const m = manifest({ permissions: ['global:perm'] });
    expect(host.register(m)).toMatchObject({ ok: false, error: { code: 'PLUGIN_PERMISSION_DENIED' } });
    const ok = host.register(manifest({ permissions: ['scoped:perm'] }));
    expect(ok.ok).toBe(true);
    m.permissions = ['escalated:perm'];
    expect(host.list()[0].permissions).toEqual(['scoped:perm']);
  });

  it('revokes registrations and blocks/cascades dependency cleanup', () => {
    const fields = createDefaultFieldRegistry();
    const host = new PluginHost({ fields });
    host.register(manifest({ id: 'base-lib' }));
    host.register(manifest({ id: 'consumer', dependencies: [{ id: 'base-lib', versionRange: '^1.0.0' }], provides: [{ kind: 'field', name: 'acme-rating' }] }), { fields: [{ type: 'acme-rating', valueType: 'integer', emptyValue: null, accepts: ['number', 'null'], capability: { fieldType: 'acme-rating', contractVersion: '1.0.0', valueType: 'integer', supportsValidation: true, supportsAsyncValidation: true, supportsAccessibility: true, supportsLocalization: true, supportsReadonly: true, supportsDisabled: true, supportsDynamicOptions: false, requiresNativeModule: false } }] });
    expect(host.unregister('base-lib')).toMatchObject({ ok: false, error: { code: 'PLUGIN_DEPENDENCY_ACTIVE' } });
    const r = host.unregister('base-lib', { cascade: true });
    expect(r.ok).toBe(true);
    expect(fields.has('acme-rating')).toBe(false);
    expect(host.list()).toEqual([]);
  });

  it('fails closed when a required registry is missing', () => {
    const host = new PluginHost();
    const r = host.register(manifest({ provides: [{ kind: 'submissionExecutor', name: 'acme' }] }), { executors: [{ scheme: 'acme', contract: { supportsOfflineQueue: false, idempotent: false, trusted: true }, supports: () => true, execute: async () => ({ status: 'business-rejected', code: 'X', message: 'x' }) }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'PLUGIN_REGISTRY_MISSING' } });
  });
});

describe('Stage 6 — UI auth is not backend identity', () => {
  it('runtime UI auth cannot grant permissions to the trusted Node executor', async () => {
    const d = doc({ security: { submitPermissions: ['submit:form'] } });
    const operations = new OperationRegistry();
    let seenAuth: AuthContext | undefined;
    operations.register('test:remediation', (_p, ctx) => { seenAuth = ctx.auth; return {}; });
    const handler = new TrustedSubmissionHandler({ forms: { 'remediation-form': d }, operations, rbac: new SimpleRbacEvaluator() });
    const executors = new SubmissionExecutorRegistry();
    executors.register(createNodeExecutor(handler, 'test', { auth: auth([]) }));
    const controller = new FormController({ ir: irOf(d), executors, uiAuth: auth(['*']), rbac: new SimpleRbacEvaluator() });
    await controller.initialize();
    const r = await controller.submit();
    expect(r.status).toBe('permission-denied');
    expect(seenAuth).toBeUndefined(); // denied before the operation executes
    controller.dispose();
  });

  it('Node executor ignores forged SubmissionContext.authenticatedContext', async () => {
    const d = doc({ security: { submitPermissions: ['submit:form'] } });
    const operations = new OperationRegistry();
    operations.register('test:remediation', () => ({}));
    const handler = new TrustedSubmissionHandler({ forms: { 'remediation-form': d }, operations, rbac: new SimpleRbacEvaluator() });
    const executor = createNodeExecutor(handler, 'test', { auth: auth([]) });
    const r = await executor.execute({ operationRef: 'test:remediation' }, {
      formId: 'remediation-form', formVersion: '1.0.0', specVersion: '1.0.0', values: { name: 'Ada' },
      authenticatedContext: auth(['*']), idempotencyKey: 'k', correlationId: 'c',
    });
    expect(r.status).toBe('permission-denied');
  });
});
