import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '../src/index';
import { SubmissionExecutorRegistry, replayOfflineQueue } from '@vds-form/submission';
import { DataSourceProviderRegistry } from '@vds-form/data-sources';
import { MemoryDraftStorage, MemoryOfflineQueue, draftScopeKey } from '@vds-form/persistence';
import type {
  DataSourceProvider, FormIR, RbacEvaluator, SubmissionAction,
  SubmissionContext, SubmissionExecutor, SubmissionResult,
} from '@vds-form/types';

const load = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const irOf = (name: string): FormIR => {
  const r = compileForm(load(name));
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};

/** Explicitly-named TEST executor — proves the contract; never a production integration. */
class TestExecutor implements SubmissionExecutor {
  readonly scheme = 'test';
  readonly contract = { supportsOfflineQueue: true, idempotent: true, trusted: false };
  calls: Array<{ action: SubmissionAction; context: SubmissionContext }> = [];
  constructor(
    private operations: Record<string, (ctx: SubmissionContext) => SubmissionResult | Promise<SubmissionResult>> = {},
    private defaultResult?: SubmissionResult,
  ) {}
  supports(action: SubmissionAction): boolean {
    return action.operationRef in this.operations || this.defaultResult !== undefined;
  }
  async execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult> {
    this.calls.push({ action, context });
    const op = this.operations[action.operationRef];
    if (op) return op(context);
    if (this.defaultResult) return this.defaultResult;
    return { status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED', message: `Unknown test operation ${action.operationRef}` };
  }
}
const success = (data: unknown = { id: 'rec-1' }): SubmissionResult =>
  ({ status: 'succeeded', operationRef: 'test:op', data, idempotencyKey: 'k', durationMs: 1 });

const executorsWith = (ops: Record<string, (ctx: SubmissionContext) => SubmissionResult | Promise<SubmissionResult>>, fallback?: SubmissionResult) => {
  const reg = new SubmissionExecutorRegistry();
  reg.register(new TestExecutor(ops, fallback));
  return reg;
};

async function init(ir: FormIR, extra: Partial<ConstructorParameters<typeof FormController>[0]> = {}) {
  const c = new FormController({ ir, ...extra });
  await c.initialize();
  return c;
}

describe('runtime: lifecycle & state machine', () => {
  it('initializes with defaults and reaches ready', async () => {
    const c = await init(irOf('invoice.vds.json'));
    expect(c.getState()).toBe('ready');
    expect(c.getFieldValue('taxRate')).toBe(15);
    expect(c.getFieldValue('subtotal')).toBe(0);
    expect(c.getValues().items).toEqual([]);
    c.dispose();
  });

  it('submit before initialize fails explicitly', async () => {
    const c = new FormController({ ir: irOf('contact.vds.json') });
    const r = await c.submit();
    expect(r).toMatchObject({ status: 'config-error', code: 'FORM_NOT_INITIALIZED' });
  });

  it('tracks dirty and touched; reset restores initial values', async () => {
    const c = await init(irOf('contact.vds.json'));
    expect(c.getSnapshot().dirty).toBe(false);
    c.setFieldValue('name', 'Ada');
    expect(c.getState()).toBe('dirty');
    expect(c.getSnapshot().dirtyPaths).toContain('name');
    expect(c.isTouched('name')).toBe(true);
    c.reset();
    expect(c.getState()).toBe('ready');
    expect(c.getFieldValue('name')).toBeNull();
    expect(c.getSnapshot().dirty).toBe(false);
    c.dispose();
  });

  it('dispose aborts work and blocks further mutation', async () => {
    const c = await init(irOf('contact.vds.json'));
    c.dispose();
    expect(c.getState()).toBe('disposed');
    expect(() => c.setFieldValue('name', 'x')).toThrow(/FORM_DISPOSED/);
    const r = await c.submit();
    expect(r).toMatchObject({ status: 'config-error', code: 'FORM_DISPOSED' });
  });

  it('suspend/resume transitions are guarded', async () => {
    const c = await init(irOf('contact.vds.json'));
    c.suspend();
    expect(c.getState()).toBe('suspended');
    c.resume();
    expect(c.getState()).toBe('ready');
    c.dispose();
  });

  it('read-only/computed fields reject writes with a diagnostic', async () => {
    const c = await init(irOf('invoice.vds.json'));
    c.setFieldValue('total', 999);
    expect(c.getFieldValue('total')).toBe(0);
    expect(c.getSnapshot().diagnostics.some((d) => d.code === 'READONLY_WRITE')).toBe(true);
    c.dispose();
  });
});

describe('runtime: conditions & formulas', () => {
  it('conditional visibility + required reacts to select changes', async () => {
    const c = await init(irOf('customer-registration.vds.json'));
    expect(c.getSnapshot().visibility.companyName).toBe(false);
    expect(c.getSnapshot().required.companyName).toBe(false);
    c.setFieldValue('customer.type', 'business');
    expect(c.getSnapshot().visibility.companyName).toBe(true);
    expect(c.getSnapshot().required.companyName).toBe(true);
    const v = await c.validate();
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.path === 'customer.companyName' && i.code === 'REQUIRED')).toBe(true);
    c.setFieldValue('customer.type', 'individual');
    expect(c.getSnapshot().visibility.companyName).toBe(false);
    c.dispose();
  });

  it('invoice: row formulas + collection aggregation update selectively', async () => {
    const c = await init(irOf('invoice.vds.json'));
    c.addRepeaterItem('items', { description: 'Widget', qty: 2, price: 10 });
    c.addRepeaterItem('items', { description: 'Gadget', qty: 3, price: 5 });
    expect(c.getFieldValue('items.0.lineTotal')).toBe(20);
    expect(c.getFieldValue('items.1.lineTotal')).toBe(15);
    expect(c.getFieldValue('subtotal')).toBe(35);
    expect(c.getFieldValue('taxAmount')).toBe(5.25);
    expect(c.getFieldValue('total')).toBe(40.25);
    const before = c.getSnapshot().metrics.evaluations;
    c.setFieldValue('items.1.qty', 4);
    expect(c.getFieldValue('items.1.lineTotal')).toBe(20);
    expect(c.getFieldValue('items.0.lineTotal')).toBe(20); // untouched row keeps value
    expect(c.getFieldValue('total')).toBe(46);
    expect(c.getSnapshot().metrics.evaluations).toBeGreaterThan(before);
    c.setFieldValue('taxRate', 0);
    expect(c.getFieldValue('taxAmount')).toBe(0);
    expect(c.getFieldValue('total')).toBe(40);
    c.dispose();
  });

  it('cross-field validation rule fires and clears', async () => {
    const c = await init(irOf('invoice.vds.json'));
    c.setFieldValue('customerName', 'ACME');
    let v = await c.validate();
    expect(v.issues.some((i) => i.code === 'CROSS_FIELD' && i.path === 'total')).toBe(true);
    c.addRepeaterItem('items', { description: 'Service', qty: 1, price: 100 });
    v = await c.validate();
    expect(v.issues.some((i) => i.code === 'CROSS_FIELD')).toBe(false);
    c.dispose();
  });
});

describe('runtime: repeaters with stable row identity', () => {
  it('add/remove/move keep row ids stable and remap touched state', async () => {
    const c = await init(irOf('invoice.vds.json'));
    const r0 = c.addRepeaterItem('items', { description: 'A', qty: 1, price: 1 })!;
    const r1 = c.addRepeaterItem('items', { description: 'B', qty: 2, price: 2 })!;
    const r2 = c.addRepeaterItem('items', { description: 'C', qty: 3, price: 3 })!;
    expect(c.getRowIds('items')).toEqual([r0, r1, r2]);
    c.setFieldValue('items.2.description', ''); // make row C invalid + touched
    expect(c.isTouched('items.2.description')).toBe(true);
    // Move row C to front: identity follows, touched follows
    c.moveRepeaterItem('items', 2, 0);
    expect(c.getRowIds('items')).toEqual([r2, r0, r1]);
    expect(c.getFieldValue('items.0.description')).toBe('');
    expect(c.isTouched('items.0.description')).toBe(true);
    expect(c.getFieldValue('items.0.lineTotal')).toBe(9);
    // Remove middle row (A): C keeps index 0, B shifts to 1
    c.removeRepeaterItem('items', r0);
    expect(c.getRowIds('items')).toEqual([r2, r1]);
    expect(c.getFieldValue('items.1.description')).toBe('B');
    expect(c.isTouched('items.0.description')).toBe(true);
    expect(c.getFieldValue('subtotal')).toBe(9 + 4);
    c.dispose();
  });

  it('enforces maxItems and validates row count', async () => {
    const doc = load('invoice.vds.json');
    doc.fields.find((f: { id: string }) => f.id === 'items').maxItems = 2;
    const r = compileForm(doc);
    if (!r.ok) throw new Error('compile');
    const c = await init(r.ir);
    c.addRepeaterItem('items', { description: 'A', qty: 1, price: 1 });
    c.addRepeaterItem('items', { description: 'B', qty: 1, price: 1 });
    expect(c.addRepeaterItem('items')).toBeNull();
    expect(c.getSnapshot().diagnostics.some((d) => d.code === 'REPEATER_MAX')).toBe(true);
    c.dispose();
  });

  it('nested groups validate and serialize correctly', async () => {
    const c = await init(irOf('nested-profile.vds.json'));
    c.setFieldValue('profile.displayName', 'Ada');
    c.setFieldValue('profile.contact.email', 'ada@example.com');
    c.setFieldValue('tags', ['a']);
    const v = await c.validate();
    expect(v.valid).toBe(true);
    expect(c.getValues().profile).toEqual({ displayName: 'Ada', contact: { email: 'ada@example.com' } });
    c.setFieldValue('profile.contact.email', 'bad');
    const v2 = await c.validate();
    expect(v2.issues.some((i) => i.path === 'profile.contact.email' && i.code === 'FORMAT_INVALID')).toBe(true);
    c.dispose();
  });
});

describe('runtime: validation', () => {
  it('required, format, length and consent semantics', async () => {
    const c = await init(irOf('customer-registration.vds.json'));
    const v = await c.validate();
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.path === 'customer.name' && i.code === 'REQUIRED')).toBe(true);
    expect(v.issues.some((i) => i.path === 'customer.consent' && i.code === 'REQUIRED')).toBe(true);
    c.setFieldValue('customer.name', 'A');
    c.setFieldValue('customer.email', 'not-an-email');
    c.setFieldValue('customer.consent', true);
    const v2 = await c.validate();
    expect(v2.issues.some((i) => i.path === 'customer.name' && i.code === 'MIN_LENGTH')).toBe(true);
    expect(v2.issues.some((i) => i.path === 'customer.email' && i.code === 'FORMAT_INVALID')).toBe(true);
    c.dispose();
  });

  it('hidden fields are excluded from validation and submission payload', async () => {
    const c = await init(irOf('customer-registration.vds.json'), {
      executors: executorsWith({ 'test:customer.create': (ctx) => success(ctx.values) }),
    });
    c.setFieldValue('customer.name', 'Ada Lovelace');
    c.setFieldValue('customer.email', 'ada@example.com');
    c.setFieldValue('customer.consent', true);
    c.setFieldValue('customer.companyName', 'should not submit'); // hidden
    const r = await c.submit();
    expect(r.status).toBe('succeeded');
    if (r.status === 'succeeded') {
      expect((r.data as Record<string, unknown>).companyName).toBeUndefined();
      expect((r.data as Record<string, unknown>).name).toBe('Ada Lovelace');
    }
    c.dispose();
  });
});

describe('runtime: async validation', () => {
  const provider = (impl: (params: Record<string, unknown>) => Promise<{ items: unknown[] }>): DataSourceProvider => ({
    scheme: 'test', query: async (req) => impl(req.params),
  });

  it('debounced uniqueness check reports async issue and clears', async () => {
    vi.useFakeTimers();
    const reg = new DataSourceProviderRegistry();
    let calls = 0;
    reg.register(provider(async (params) => {
      calls += 1;
      return { items: [{ valid: params.value !== 'taken@example.com' }] };
    }));
    const c = new FormController({ ir: irOf('customer-registration.vds.json'), dataProviders: reg });
    await c.initialize();
    c.setFieldValue('customer.email', 'taken@example.com');
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(1);
    expect(c.getSnapshot().issues.some((i) => i.source === 'async' && i.path === 'customer.email')).toBe(true);
    c.setFieldValue('customer.email', 'free@example.com');
    await vi.advanceTimersByTimeAsync(250);
    expect(c.getSnapshot().issues.some((i) => i.source === 'async')).toBe(false);
    c.dispose();
    vi.useRealTimers();
  });

  it('stale responses never overwrite newer state', async () => {
    vi.useFakeTimers();
    const reg = new DataSourceProviderRegistry();
    const resolvers: Array<(v: { items: unknown[] }) => void> = [];
    reg.register({ scheme: 'test', query: () => new Promise((res) => { resolvers.push(res); }) });
    const c = new FormController({ ir: irOf('customer-registration.vds.json'), dataProviders: reg });
    await c.initialize();
    c.setFieldValue('customer.email', 'first@example.com');
    await vi.advanceTimersByTimeAsync(250);
    c.setFieldValue('customer.email', 'second@example.com');
    await vi.advanceTimersByTimeAsync(250);
    expect(resolvers.length).toBe(2);
    // Resolve the NEWER request first, then the stale one with a failure.
    resolvers[1]({ items: [{ valid: true }] });
    await vi.advanceTimersByTimeAsync(10);
    resolvers[0]({ items: [{ valid: false }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(c.getSnapshot().issues.some((i) => i.source === 'async')).toBe(false);
    c.dispose();
    vi.useRealTimers();
  });

  it('missing async provider produces explicit error issue', async () => {
    vi.useFakeTimers();
    const c = new FormController({ ir: irOf('customer-registration.vds.json') });
    await c.initialize();
    c.setFieldValue('customer.email', 'x@example.com');
    await vi.advanceTimersByTimeAsync(250);
    expect(c.getSnapshot().issues.some((i) => i.code === 'ASYNC_PROVIDER_NOT_REGISTERED')).toBe(true);
    c.dispose();
    vi.useRealTimers();
  });
});

describe('runtime: data sources', () => {
  it('dependent dropdowns load, cache and reload on dependency change', async () => {
    const reg = new DataSourceProviderRegistry();
    const calls: Array<Record<string, unknown>> = [];
    reg.register({
      scheme: 'test',
      query: async (req) => {
        calls.push({ ref: req.providerRef, ...req.params });
        if (req.providerRef === 'test:geo.countries') return { items: [{ code: 'PK', name: 'Pakistan' }, { code: 'US', name: 'USA' }] };
        if (req.providerRef === 'test:geo.cities') {
          return { items: req.params.country === 'PK' ? [{ code: 'ISB', name: 'Islamabad' }, { code: 'LHR', name: 'Lahore' }] : [{ code: 'NYC', name: 'New York' }] };
        }
        return { items: [] };
      },
    });
    const c = new FormController({ ir: irOf('business-address.vds.json'), dataProviders: reg });
    await c.initialize();
    await c.loadAllSources();
    expect(c.getOptions('country').map((o) => o.value)).toEqual(['PK', 'US']);
    expect(c.getSnapshot().dataSources.cities.status).toBe('idle'); // country not chosen yet
    c.setFieldValue('address.country', 'PK');
    await c.loadSource('cities');
    expect(c.getOptions('city').map((o) => o.label)).toEqual(['Islamabad', 'Lahore']);
    c.setFieldValue('address.country', 'US');
    await c.loadSource('cities');
    expect(c.getOptions('city').map((o) => o.label)).toEqual(['New York']);
    expect(calls.filter((x) => x.ref === 'test:geo.countries').length).toBe(1); // cached
    c.dispose();
  });

  it('missing provider yields explicit DATA_PROVIDER_NOT_REGISTERED status', async () => {
    const c = await init(irOf('business-address.vds.json'));
    await c.loadAllSources();
    expect(c.getSnapshot().dataSources.countries.error?.code).toBe('DATA_PROVIDER_NOT_REGISTERED');
    c.dispose();
  });
});

describe('runtime: submission lifecycle', () => {
  it('missing executor registry fails with SUBMISSION_EXECUTOR_NOT_REGISTERED', async () => {
    const c = await init(irOf('contact.vds.json'));
    c.setFieldValue('name', 'Ada');
    c.setFieldValue('email', 'ada@example.com');
    c.setFieldValue('message', 'Hello there, this is a message.');
    const r = await c.submit();
    expect(r).toMatchObject({ status: 'config-error', code: 'SUBMISSION_EXECUTOR_NOT_REGISTERED' });
    expect(c.getState()).toBe('submission-failed');
    c.dispose();
  });

  it('unresolved operation fails with SUBMISSION_OPERATION_UNRESOLVED', async () => {
    const c = await init(irOf('contact.vds.json'), { executors: executorsWith({}) });
    c.setFieldValue('name', 'Ada');
    c.setFieldValue('email', 'ada@example.com');
    c.setFieldValue('message', 'Hello there, this is a message.');
    const r = await c.submit();
    expect(r).toMatchObject({ status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED' });
    c.dispose();
  });

  it('validation failure blocks execution entirely', async () => {
    const exec = new TestExecutor({ 'test:contact.create': () => success() });
    const reg = new SubmissionExecutorRegistry(); reg.register(exec);
    const c = await init(irOf('contact.vds.json'), { executors: reg });
    const r = await c.submit();
    expect(r.status).toBe('validation-failed');
    expect(exec.calls.length).toBe(0);
    expect(c.getState()).toBe('invalid');
    c.dispose();
  });

  it('successful submission carries idempotency key, mapped payload and updates state', async () => {
    const exec = new TestExecutor({ 'test:contact.create': (ctx) => success({ created: true, echo: ctx.values }) });
    const reg = new SubmissionExecutorRegistry(); reg.register(exec);
    const c = await init(irOf('contact.vds.json'), { executors: reg });
    c.setFieldValue('name', 'Ada');
    c.setFieldValue('email', 'ada@example.com');
    c.setFieldValue('message', 'Hello there, this is a message.');
    const r = await c.submit();
    expect(r.status).toBe('succeeded');
    expect(c.getState()).toBe('submission-succeeded');
    expect(exec.calls.length).toBe(1);
    expect(exec.calls[0].context.idempotencyKey).toBeTruthy();
    expect(exec.calls[0].context.formId).toBe('contact');
    expect(exec.calls[0].context.values).toEqual({ name: 'Ada', email: 'ada@example.com', message: 'Hello there, this is a message.' });
    c.dispose();
  });

  it('concurrent submits are locked', async () => {
    let release!: (v: SubmissionResult) => void;
    const exec = new TestExecutor({ 'test:contact.create': () => new Promise<SubmissionResult>((res) => { release = res; }) });
    const reg = new SubmissionExecutorRegistry(); reg.register(exec);
    const c = await init(irOf('contact.vds.json'), { executors: reg });
    c.setFieldValue('name', 'Ada');
    c.setFieldValue('email', 'ada@example.com');
    c.setFieldValue('message', 'Hello there, this is a message.');
    const p1 = c.submit();
    const p2 = await c.submit();
    expect(p2).toMatchObject({ status: 'config-error', code: 'SUBMISSION_IN_PROGRESS' });
    // Wait until the executor is actually invoked (after async validation settles).
    for (let i = 0; i < 100 && typeof release !== 'function'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    release(success());
    expect((await p1).status).toBe('succeeded');
    expect(exec.calls.length).toBe(1);
    c.dispose();
  });

  it('RBAC denial is explicit and never executes', async () => {
    const exec = new TestExecutor({ 'test:customer.create': () => success() });
    const reg = new SubmissionExecutorRegistry(); reg.register(exec);
    const rbac: RbacEvaluator = { evaluate: (_auth, required) => ({ allowed: false, missing: required }) };
    const c = await init(irOf('customer-registration.vds.json'), { executors: reg, rbac, auth: { roles: [], permissions: [] } });
    c.setFieldValue('customer.name', 'Ada Lovelace');
    c.setFieldValue('customer.email', 'ada@example.com');
    c.setFieldValue('customer.consent', true);
    const r = await c.submit();
    expect(r).toMatchObject({ status: 'permission-denied', requiredPermissions: ['customer:create'] });
    expect(exec.calls.length).toBe(0);
    c.dispose();
  });

  it('server validation failures merge into issues', async () => {
    const exec = new TestExecutor({
      'test:contact.create': () => ({
        status: 'server-validation-failed',
        issues: [{ code: 'SERVER_REJECTED', message: 'Email blocked by server.', path: 'email', severity: 'error', source: 'server' }],
      }),
    });
    const reg = new SubmissionExecutorRegistry(); reg.register(exec);
    const c = await init(irOf('contact.vds.json'), { executors: reg });
    c.setFieldValue('name', 'Ada');
    c.setFieldValue('email', 'ada@example.com');
    c.setFieldValue('message', 'Hello there, this is a message.');
    const r = await c.submit();
    expect(r.status).toBe('server-validation-failed');
    expect(c.getSnapshot().issues.some((i) => i.source === 'server')).toBe(true);
    c.dispose();
  });

  it('onSuccess workflow hook runs conditionally through a registered executor', async () => {
    const calls: string[] = [];
    const reg = new SubmissionExecutorRegistry();
    reg.register(new TestExecutor({ 'test:purchase.create': () => { calls.push('create'); return success({ id: 'p1' }); } }));
    reg.register({
      scheme: 'workflow',
      contract: { supportsOfflineQueue: false, idempotent: false, trusted: true },
      supports: () => true,
      execute: async (action, ctx) => { calls.push(`workflow:${ctx.values.amount}`); return success({ started: true }); },
    });
    const c = await init(irOf('purchase-approval.vds.json'), { executors: reg });
    c.setFieldValue('request.item', 'Laptop');
    c.setFieldValue('request.amount', 1500);
    c.setFieldValue('request.department', 'eng');
    c.setFieldValue('request.justification', 'Needed for the new engineering hire onboarding.');
    const r = await c.submit();
    expect(r.status).toBe('succeeded');
    expect(calls).toEqual(['create', 'workflow:1500']);
    c.dispose();
  });

  it('stable idempotency keys derive from configured stable fields', async () => {
    const exec = new TestExecutor({ 'test:survey.create': () => success() });
    const reg = new SubmissionExecutorRegistry(); reg.register(exec);
    const c = await init(irOf('field-survey.vds.json'), { executors: reg });
    c.setFieldValue('survey.site', 'Site-42');
    c.setFieldValue('survey.rating', 4);
    await c.submit();
    const key1 = exec.calls[0].context.idempotencyKey;
    c.reset();
    c.setFieldValue('survey.site', 'Site-42');
    c.setFieldValue('survey.rating', 5);
    await c.submit();
    expect(exec.calls[1].context.idempotencyKey).toBe(key1);
    expect(key1.startsWith('stable-field-survey-')).toBe(true);
    c.dispose();
  });
});

describe('runtime: offline queue & drafts', () => {
  it('queues offline only when permitted; queued ≠ succeeded', async () => {
    const queue = new MemoryOfflineQueue();
    const exec = new TestExecutor({ 'test:survey.create': () => success() });
    const reg = new SubmissionExecutorRegistry(); reg.register(exec);
    const c = await init(irOf('field-survey.vds.json'), {
      executors: reg, offlineQueue: queue, isOnline: () => false,
      auth: { userId: 'u1', tenantId: 't1', roles: [], permissions: [] },
    });
    c.setFieldValue('survey.site', 'Site-1');
    c.setFieldValue('survey.rating', 3);
    const r = await c.submit();
    expect(r.status).toBe('queued-offline');
    expect(c.getState()).toBe('offline-queued');
    expect(exec.calls.length).toBe(0);
    const records = await queue.list(draftScopeKey(irOf('field-survey.vds.json').persistence, c.auth));
    expect(records.length).toBe(1);
    expect(records[0].status).toBe('queued');
    // Replay through the real executor when back online.
    const summary = await replayOfflineQueue(records, reg, (id, patch) => queue.update(id, patch));
    expect(summary.sent.length).toBe(1);
    expect(exec.calls.length).toBe(1);
    expect(exec.calls[0].context.idempotencyKey).toBe(records[0].idempotencyKey);
    c.dispose();
  });

  it('offline without queue permission fails retryable, never fake-success', async () => {
    const c = await init(irOf('contact.vds.json'), {
      executors: executorsWith({ 'test:contact.create': () => success() }),
      isOnline: () => false,
    });
    c.setFieldValue('name', 'Ada');
    c.setFieldValue('email', 'ada@example.com');
    c.setFieldValue('message', 'Hello there, this is a message.');
    const r = await c.submit();
    expect(r).toMatchObject({ status: 'network-failure', retryable: true });
    c.dispose();
  });

  it('duplicate queued idempotency keys are rejected', async () => {
    const queue = new MemoryOfflineQueue();
    const c = await init(irOf('field-survey.vds.json'), {
      executors: executorsWith({ 'test:survey.create': () => success() }),
      offlineQueue: queue, isOnline: () => false,
    });
    c.setFieldValue('survey.site', 'Same');
    c.setFieldValue('survey.rating', 2);
    expect((await c.submit()).status).toBe('queued-offline');
    const again = await c.submit();
    expect(again).toMatchObject({ status: 'config-error', code: 'OFFLINE_QUEUE_NOT_PERMITTED' });
    c.dispose();
  });

  it('drafts save/restore with user isolation and version conflict policy', async () => {
    const storage = new MemoryDraftStorage();
    const ir = irOf('customer-registration.vds.json');
    const auth = { userId: 'u1', tenantId: 't1', roles: [], permissions: [] };
    const c1 = await init(ir, { drafts: storage, auth });
    c1.setFieldValue('customer.name', 'Draft User');
    await c1.saveDraft();
    expect(c1.getSnapshot().draft.status).toBe('saved');
    c1.dispose();

    const c2 = await init(ir, { drafts: storage, auth });
    expect(c2.getSnapshot().draft.status).toBe('restored');
    expect(c2.getFieldValue('customer.name')).toBe('Draft User');
    c2.dispose();

    const otherUser = await init(ir, { drafts: storage, auth: { ...auth, userId: 'u2' } });
    expect(otherUser.getFieldValue('customer.name')).toBeNull(); // isolated
    otherUser.dispose();

    const newerVersion = { ...ir, formVersion: '9.9.9' };
    const conflicted = await init(newerVersion, { drafts: storage, auth });
    expect(conflicted.getSnapshot().draft.status).toBe('conflict');
    expect(conflicted.getFieldValue('customer.name')).toBeNull(); // not auto-applied
    await conflicted.resolveDraftConflict('apply');
    expect(conflicted.getFieldValue('customer.name')).toBe('Draft User');
    conflicted.dispose();
  });
});

describe('runtime: subscriptions & inspection', () => {
  it('selective field subscriptions fire only for relevant changes', async () => {
    const c = await init(irOf('contact.vds.json'));
    const nameSpy = vi.fn();
    const emailSpy = vi.fn();
    const unsubName = c.subscribeField('name', nameSpy);
    c.subscribeField('email', emailSpy);
    c.setFieldValue('name', 'Ada');
    expect(nameSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).toHaveBeenCalledTimes(0);
    c.setFieldValue('email', 'ada@example.com');
    expect(emailSpy).toHaveBeenCalledTimes(1);
    unsubName();
    c.setFieldValue('name', 'Grace');
    expect(nameSpy).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it('snapshot is immutable-ish and listeners cleaned on dispose', async () => {
    const c = await init(irOf('contact.vds.json'));
    const spy = vi.fn();
    c.subscribe(spy);
    c.setFieldValue('name', 'Ada');
    expect(spy).toHaveBeenCalled();
    const snap = c.getSnapshot();
    snap.values.name = 'MUTATED';
    expect(c.getFieldValue('name')).toBe('Ada');
    c.dispose();
    const calls = spy.mock.calls.length;
    expect(c.getSnapshot().state).toBe('disposed');
    expect(spy.mock.calls.length).toBe(calls);
  });
});
