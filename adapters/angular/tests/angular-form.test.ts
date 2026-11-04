import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import { TestOperationExecutor, TestUploadProvider, succeeded } from '@vds-form/vds-contracts';
import type { FormIR } from '@vds-form/types';
import { UniversalFormComponent, ANGULAR_CAPABILITY_MANIFEST } from '../src/index';

const load = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const irOf = (name: string): FormIR => {
  const r = compileForm(load(name));
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};
const testExecutors = (op: string) => {
  const r = new SubmissionExecutorRegistry();
  r.register(new TestOperationExecutor('test', { [op]: (ctx) => succeeded(op, { id: 'x1' }, ctx) }));
  return r;
};
const tick = () => new Promise((r) => setTimeout(r, 20));

async function mount(name: string, extra: Partial<ConstructorParameters<typeof FormController>[0]> = {}) {
  const controller = new FormController({ ir: irOf(name), ...extra });
  await controller.initialize();
  await TestBed.configureTestingModule({ imports: [UniversalFormComponent] }).compileComponents();
  const fixture = TestBed.createComponent(UniversalFormComponent);
  fixture.componentRef.setInput('controller', controller);
  fixture.detectChanges();
  return { controller, fixture, el: fixture.nativeElement as HTMLElement };
}
const q = (el: HTMLElement, testid: string) => el.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const setInput = (el: HTMLElement, testid: string, value: string) => {
  const input = q(el, testid) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('Angular renderer', () => {
  beforeEach(() => { TestBed.resetTestingModule(); });

  it('renders the canonical contact form and submits through the registered executor', async () => {
    const { controller, fixture, el } = await mount('contact.vds.json', { executors: testExecutors('test:contact.create') });
    setInput(el, 'input-name', 'Ada Lovelace');
    setInput(el, 'input-email', 'ada@example.com');
    setInput(el, 'input-message', 'Hello from the Angular renderer.');
    fixture.detectChanges();
    q(el, 'submit-button')!.click();
    await tick(); fixture.detectChanges();
    expect(q(el, 'submit-success')).toBeTruthy();
    expect(controller.getState()).toBe('submission-succeeded');
    controller.dispose();
  });

  it('shows field errors after touch', async () => {
    const { controller, fixture, el } = await mount('contact.vds.json', { executors: testExecutors('test:contact.create') });
    setInput(el, 'input-email', 'bad');
    q(el, 'input-email')!.dispatchEvent(new Event('blur', { bubbles: true }));
    await tick(); fixture.detectChanges();
    expect(q(el, 'error-email')).toBeTruthy();
    controller.dispose();
  });

  it('conditional business field reveals and submits', async () => {
    const { controller, fixture, el } = await mount('customer-registration.vds.json', { executors: testExecutors('test:customer.create') });
    expect(q(el, 'field-customer.companyName')).toBeNull();
    const sel = q(el, 'input-customer.type') as HTMLSelectElement;
    sel.value = 'business';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(); fixture.detectChanges();
    expect(q(el, 'input-customer.companyName')).toBeTruthy();
    setInput(el, 'input-customer.name', 'Grace Hopper');
    setInput(el, 'input-customer.email', 'grace@example.com');
    setInput(el, 'input-customer.companyName', 'Navy Labs');
    const consent = q(el, 'input-customer.consent') as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event('change', { bubbles: true }));
    fixture.detectChanges();
    q(el, 'submit-button')!.click();
    await tick(); fixture.detectChanges();
    expect(q(el, 'submit-success')).toBeTruthy();
    controller.dispose();
  });

  it('invoice repeater computes totals live', async () => {
    const { controller, fixture, el } = await mount('invoice.vds.json', { executors: testExecutors('test:invoice.create') });
    q(el, 'add-items')!.click();
    fixture.detectChanges();
    setInput(el, 'input-items.0.description', 'Widget');
    setInput(el, 'input-items.0.qty', '3');
    setInput(el, 'input-items.0.price', '10');
    await tick(); fixture.detectChanges();
    expect(q(el, 'computed-items.0.lineTotal')!.textContent).toBe('30');
    expect(q(el, 'computed-total')!.textContent).toBe('34.5');
    controller.dispose();
  });

  it('drag-and-drop upload stores the asset reference', async () => {
    const uploadProvider = new TestUploadProvider();
    const { controller, fixture, el } = await mount('kyc-documents.vds.json', { uploadProvider });
    const file = new File(['png'], 'id.png', { type: 'image/png' });
    const dz = q(el, 'dropzone-kyc.selfie')!;
    const evt = new Event('drop', { bubbles: true }) as DragEvent;
    Object.defineProperty(evt, 'dataTransfer', { value: { files: [file] } });
    dz.dispatchEvent(evt);
    await tick(); fixture.detectChanges();
    expect(q(el, 'asset-kyc.selfie')!.textContent).toContain('id.png');
    expect(uploadProvider.assets.size).toBe(1);
    controller.dispose();
  });

  it('nested groups render with correct paths', async () => {
    const { controller, fixture, el } = await mount('nested-profile.vds.json', { executors: testExecutors('test:profile.save') });
    expect(q(el, 'group-profile')).toBeTruthy();
    setInput(el, 'input-profile.displayName', 'Ada');
    setInput(el, 'input-profile.contact.email', 'ada@example.com');
    fixture.detectChanges();
    expect(controller.getValues().profile).toEqual({ displayName: 'Ada', contact: { email: 'ada@example.com' } });
    controller.dispose();
  });

  it('capability negotiation passes for shared examples', () => {
    for (const name of ['contact.vds.json', 'customer-registration.vds.json', 'invoice.vds.json', 'kyc-documents.vds.json']) {
      expect(compileForm(load(name), { target: ANGULAR_CAPABILITY_MANIFEST }).ok, name).toBe(true);
    }
  });

  it('destroy cleans up subscriptions', async () => {
    const { controller, fixture } = await mount('contact.vds.json');
    fixture.destroy();
    expect(() => controller.setFieldValue('name', 'After destroy')).not.toThrow();
    controller.dispose();
  });
});
