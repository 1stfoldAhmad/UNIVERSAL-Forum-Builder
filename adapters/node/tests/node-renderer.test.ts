import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import type { FormIR } from '@vds-form/types';
const irOf = (d: FormDocument): FormIR => { const r = compileForm(d); if (!r.ok) throw new Error('compile failed: ' + r.diagnostics.map((x) => x.message).join('; ')); return r.ir; };
import { FormController } from '@vds-form/runtime';
import { OperationRegistry } from '@vds-form/execution-node';
import { InMemoryRecordStore, SimpleRbacEvaluator } from '@vds-form/vds-contracts';
import type { AuthContext, FormDocument } from '@vds-form/types';
import { renderForm, createNodeFormHandler, parseFormValues, parseUrlEncoded, NODE_CAPABILITY_MANIFEST } from '../src/index';

const load = (name: string): FormDocument => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const auth = (permissions: string[]): AuthContext => ({ userId: 'u1', tenantId: 't1', roles: [], permissions });
const validCustomer = { customer: { name: 'Ada Lovelace', email: 'ada@example.com', type: 'individual', consent: true } };

function setup(formName = 'customer-registration.vds.json') {
  const store = new InMemoryRecordStore();
  const operations = new OperationRegistry();
  operations.register('test:customer.create', (payload) => store.create('customer', payload));
  const handler = createNodeFormHandler({
    forms: { 'customer-registration': load(formName) },
    operations,
    rbac: new SimpleRbacEvaluator(),
    resolveAuth: (req) => auth(req.headers.get('x-test-permissions')?.split(',').filter(Boolean) ?? ['customer:create']),
    basePath: '/forms',
  });
  return { store, handler };
}

const stepsDoc = {
  format: 'vds.form', specVersion: '1.0.0', id: 'wide', metadata: { name: 'Wide', version: '1.0.0' },
  fields: [
    { id: 'g', type: 'group', key: 'customer', label: 'Customer', children: [{ id: 'gname', type: 'text', key: 'customer.name', label: 'Name', required: true }] },
    { id: 'sel', type: 'select', key: 'sel', label: 'Sel', options: [{ value: 'a', label: 'A' }] },
    { id: 'ms', type: 'multiselect', key: 'ms', label: 'MS', options: [{ value: 'x', label: 'X' }] },
    { id: 'rad', type: 'radio', key: 'rad', label: 'Rad', options: [{ value: 'y', label: 'Y' }] },
    { id: 'chk', type: 'checkbox', key: 'chk', label: 'Chk' },
    { id: 'rt', type: 'rating', key: 'rt', label: 'Rating' },
    { id: 'rng', type: 'range', key: 'rng', label: 'Range' },
    { id: 'dt', type: 'date', key: 'dt', label: 'Date' },
    { id: 'cur', type: 'currency', key: 'cur', label: 'Cost' },
  ],
  layout: { type: 'section', children: [{ type: 'steps', children: [
    { type: 'step', title: 'One', fieldRefs: ['g', 'sel', 'ms', 'rad', 'chk', 'rt', 'rng', 'dt', 'cur'] },
    { type: 'step', title: 'Two', fieldRefs: [] },
  ] }] },
  submission: { operationRef: 'test:customer.create' },
} as unknown as FormDocument;

describe('Node SSR renderer', () => {
  it('renders the registration example with labels, names and email input', async () => {
    const ir = irOf(load('customer-registration.vds.json'));
    const ctrl = new FormController({ ir });
    await ctrl.initialize();
    const html = renderForm(ctrl, { action: '/forms/customer-registration' });
    expect(html).toContain('data-vds-form="customer-registration"');
    for (const f of ir.fields.filter((x) => !x.parentId && x.type !== 'hidden')) expect(html).toContain(`data-field-id="${f.id}"`);
    expect(html).toContain('name="customer.name"');
    expect(html).toContain('name="customer.email"');
    expect(html).toContain('type="email"');
    ctrl.dispose();
  });

  it('renders repeaters with concrete row paths and computed outputs (invoice)', async () => {
    const ir = irOf(load('invoice.vds.json'));
    const ctrl = new FormController({ ir, initialValues: { items: [{ description: 'A', qty: 2, price: 5 }, { description: 'B', qty: 3, price: 4 }] } });
    await ctrl.initialize();
    const html = renderForm(ctrl);
    expect(html).toContain('data-repeater="items"');
    expect(html).toContain('data-row-index="0"');
    expect(html).toContain('data-row-index="1"');
    expect(html).toContain('name="items.0.qty"');
    expect(html).toContain('name="items.1.price"');
    expect(html).toContain('data-computed="total"');
    ctrl.dispose();
  });

  it('renders groups and multi-step layout with all choice/control types', async () => {
    const ir = irOf(stepsDoc);
    const ctrl = new FormController({ ir });
    await ctrl.initialize();
    const html = renderForm(ctrl);
    expect(html).toContain('data-field-id="g"');
    expect(html).toContain('name="customer.name"');
    expect(html).toContain('data-step="0"');
    expect(html).toContain('data-step="1"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('multiple');
    expect(html).toContain('type="range"');
    expect(html).toContain('type="date"');
    ctrl.dispose();
  });

  it('localizes labels and escapes untrusted text', async () => {
    const doc = {
      format: 'vds.form', specVersion: '1.0.0', id: 'loc', metadata: { name: 'L', version: '1.0.0' },
      localization: { defaultLocale: 'fr', locales: ['fr', 'en'] },
      fields: [{ id: 'n', type: 'text', key: 'n', label: { fr: 'Nom <script>', en: 'Name' }, defaultValue: '<b>x</b>' }],
      layout: { type: 'section', fieldRefs: ['n'] },
      submission: { operationRef: 'test:customer.create' },
    } as unknown as FormDocument;
    const ctrl = new FormController({ ir: irOf(doc) });
    await ctrl.initialize();
    const html = renderForm(ctrl, { locale: 'fr' });
    expect(html).toContain('Nom &lt;script&gt;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    ctrl.dispose();
  });

  it('parses no-JS urlencoded bodies into typed nested values', () => {
    const ir = irOf(load('customer-registration.vds.json'));
    const raw = parseUrlEncoded('customer.name=Ada&customer.email=ada%40example.com&customer.type=individual&customer.consent=true&_csrf=token');
    const values = parseFormValues(ir, raw);
    expect(values).toMatchObject({ customer: { name: 'Ada', email: 'ada@example.com', type: 'individual', consent: true } });
    expect(values).not.toHaveProperty('_csrf');
  });
});

describe('Node HTTP handler', () => {
  it('GET renders an HTML page', async () => {
    const { handler } = setup();
    const res = await handler.handle(new Request('http://x/forms/customer-registration'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-vds-form="customer-registration"');
  });

  it('POST executes the trusted operation and persists a record', async () => {
    const { handler, store } = setup();
    const res = await handler.handle(new Request('http://x/forms/customer-registration?format=json', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: validCustomer, idempotencyKey: 'k1' }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('succeeded');
    expect(store.list('customer').length).toBe(1);
  });

  it('POST re-renders server validation errors as HTML', async () => {
    const { handler, store } = setup();
    const res = await handler.handle(new Request('http://x/forms/customer-registration', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'customer.name=Ada',
    }));
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('data-error-for');
    expect(store.list('customer').length).toBe(0);
  });

  it('POST denies when the server-derived principal lacks permission', async () => {
    const { handler, store } = setup();
    const res = await handler.handle(new Request('http://x/forms/customer-registration?format=json', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-permissions': '' },
      body: JSON.stringify({ values: validCustomer, idempotencyKey: 'k2' }),
    }));
    expect(res.status).toBe(403);
    expect(store.list('customer').length).toBe(0);
  });

  it('capability manifest covers the registry minus signature', () => {
    expect(NODE_CAPABILITY_MANIFEST.target).toBe('node');
    expect(NODE_CAPABILITY_MANIFEST.fieldTypes['text']).toBeDefined();
    expect(NODE_CAPABILITY_MANIFEST.fieldTypes['signature']).toBeUndefined();
    expect(NODE_CAPABILITY_MANIFEST.features.multiStep).toBe(true);
  });
});
