import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import type { FormIR } from '@vds-form/types';
const irOf = (d: FormDocument): FormIR => { const r = compileForm(d); if (!r.ok) throw new Error('compile failed: ' + r.diagnostics.map((x) => x.message).join('; ')); return r.ir; };
import { FormController } from '@vds-form/runtime';
import type { FormDocument } from '@vds-form/types';
import { renderForm } from '../src/html';

(window as unknown as { __vdsNoAutoHydrate: boolean }).__vdsNoAutoHydrate = true;
const { hydrateForms } = await import('../src/client');

const load = (name: string): FormDocument => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const flush = () => new Promise((r) => setTimeout(r, 20));

async function mount(doc: FormDocument, values: Record<string, unknown> = {}) {
  const ir = irOf(doc);
  const ctrl = new FormController({ ir, initialValues: values });
  await ctrl.initialize();
  document.body.innerHTML = renderForm(ctrl, { action: '/forms/' + ir.formId });
  ctrl.dispose();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'succeeded' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const controllers = hydrateForms(document, { fetch: fetchMock as unknown as typeof fetch });
  await flush();
  return { form: document.querySelector('form')!, fetchMock, ctrl: controllers[0] };
}

const setInput = (form: HTMLFormElement, name: string, value: string) => {
  const el = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('Node hydration client', () => {
  it('binds inputs and applies conditions live', async () => {
    const { form, ctrl } = await mount(load('customer-registration.vds.json'));
    const company = form.querySelector<HTMLElement>('[data-path="customer.companyName"]')!;
    expect(company.dataset.visible).toBe('false');
    const sel = form.querySelector<HTMLSelectElement>('[name="customer.type"]')!;
    sel.value = 'business';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(company.dataset.visible).toBe('true');
    expect(ctrl.getFieldValue('customer.type')).toBe('business');
  });

  it('computes formulas and renders repeater rows', async () => {
    const { form, ctrl } = await mount(load('invoice.vds.json'), { items: [{ description: 'A', qty: 2, price: 5 }] });
    await flush();
    expect(ctrl.getFieldValue('items.0.lineTotal')).toBe(10);
    expect(form.querySelector('[data-computed="items.0.lineTotal"]')?.textContent).toBe('10');
    const add = form.querySelector<HTMLElement>('[data-action="add-row"]')!;
    add.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(form.querySelectorAll('.vds-row').length).toBe(2);
  });

  it('submits field values to the trusted endpoint as JSON', async () => {
    const { form, fetchMock } = await mount(load('customer-registration.vds.json'));
    setInput(form, 'customer.name', 'Ada Lovelace');
    setInput(form, 'customer.email', 'ada@example.com');
    const consent = form.querySelector<HTMLInputElement>('[name="customer.consent"]')!;
    consent.checked = true;
    consent.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('format=json');
    const body = JSON.parse(init.body as string);
    expect(body.values.customer.name).toBe('Ada Lovelace');
    expect(body.idempotencyKey).toBeTruthy();
    expect(form.querySelector('[data-vds-status]')?.textContent).toContain('Submitted successfully');
  });

  it('blocks submission and shows client validation errors', async () => {
    const { form, fetchMock } = await mount(load('customer-registration.vds.json'));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(form.querySelector('[data-error-for]')).toBeTruthy();
  });
});
