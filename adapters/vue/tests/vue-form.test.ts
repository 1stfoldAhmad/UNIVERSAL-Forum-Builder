import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import { TestOperationExecutor, TestUploadProvider, succeeded } from '@vds-form/vds-contracts';
import type { FormIR } from '@vds-form/types';
import { VUniversalForm, VUE_CAPABILITY_MANIFEST } from '../src/index';

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

async function mountForm(name: string, extra: Partial<ConstructorParameters<typeof FormController>[0]> = {}) {
  const controller = new FormController({ ir: irOf(name), ...extra });
  await controller.initialize();
  const wrapper = mount(VUniversalForm, { props: { controller } });
  return { controller, wrapper };
}

describe('Vue renderer', () => {
  it('file picker button opens the hidden input, uploads, and resets the input', async () => {
    const uploadProvider = new TestUploadProvider();
    const { controller, wrapper } = await mountForm('kyc-documents.vds.json', { uploadProvider });
    const input = wrapper.get('[data-testid="file-input-kyc.selfie"]');
    const file = new File(['x'], 'id.png', { type: 'image/png' });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('change'));
    });
    await wrapper.get('[data-testid="pick-kyc.selfie"]').trigger('click');
    await tick(); await wrapper.vm.$nextTick();
    expect(clickSpy).toHaveBeenCalled();
    expect(wrapper.get('[data-testid="asset-kyc.selfie"]').text()).toContain('id.png');
    expect((input.element as HTMLInputElement).value).toBe('');
    clickSpy.mockRestore();
    controller.dispose(); wrapper.unmount();
  });

  it('renders the canonical contact form and submits through the registered executor', async () => {
    const { controller, wrapper } = await mountForm('contact.vds.json', { executors: testExecutors('test:contact.create') });
    await wrapper.get('[data-testid="input-name"]').setValue('Ada Lovelace');
    await wrapper.get('[data-testid="input-email"]').setValue('ada@example.com');
    await wrapper.get('[data-testid="input-message"]').setValue('Hello from the Vue renderer.');
    await wrapper.get('[data-testid="submit-button"]').trigger('click');
    await tick(); await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="submit-success"]').exists()).toBe(true);
    expect(controller.getState()).toBe('submission-succeeded');
    controller.dispose(); wrapper.unmount();
  });

  it('shows field errors with aria-invalid after touch', async () => {
    const { controller, wrapper } = await mountForm('contact.vds.json', { executors: testExecutors('test:contact.create') });
    const email = wrapper.get('[data-testid="input-email"]');
    await email.setValue('not-an-email');
    await email.trigger('blur');
    await tick(); await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="error-email"]').exists()).toBe(true);
    expect(email.attributes('aria-invalid')).toBe('true');
    controller.dispose(); wrapper.unmount();
  });

  it('conditional business field reveals and the form submits', async () => {
    const { controller, wrapper } = await mountForm('customer-registration.vds.json', { executors: testExecutors('test:customer.create') });
    expect(wrapper.find('[data-testid="field-customer.companyName"]').exists()).toBe(false);
    await wrapper.get('[data-testid="input-customer.type"]').setValue('business');
    await tick(); await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="input-customer.companyName"]').exists()).toBe(true);
    await wrapper.get('[data-testid="input-customer.name"]').setValue('Grace Hopper');
    await wrapper.get('[data-testid="input-customer.email"]').setValue('grace@example.com');
    await wrapper.get('[data-testid="input-customer.companyName"]').setValue('Navy Labs');
    await wrapper.get('[data-testid="input-customer.consent"]').setValue(true);
    await wrapper.get('[data-testid="submit-button"]').trigger('click');
    await tick(); await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="submit-success"]').exists()).toBe(true);
    controller.dispose(); wrapper.unmount();
  });

  it('invoice repeater computes totals live', async () => {
    const { controller, wrapper } = await mountForm('invoice.vds.json', { executors: testExecutors('test:invoice.create') });
    await wrapper.get('[data-testid="add-items"]').trigger('click');
    await wrapper.get('[data-testid="input-items.0.description"]').setValue('Widget');
    await wrapper.get('[data-testid="input-items.0.qty"]').setValue('3');
    await wrapper.get('[data-testid="input-items.0.price"]').setValue('10');
    await tick(); await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="computed-items.0.lineTotal"]').text()).toBe('30');
    expect(wrapper.get('[data-testid="computed-total"]').text()).toBe('34.5');
    controller.dispose(); wrapper.unmount();
  });

  it('drag-and-drop upload stores the asset reference', async () => {
    const uploadProvider = new TestUploadProvider();
    const { controller, wrapper } = await mountForm('kyc-documents.vds.json', { uploadProvider });
    const file = new File(['png'], 'id.png', { type: 'image/png' });
    const dz = wrapper.get('[data-testid="dropzone-kyc.selfie"]');
    await dz.trigger('drop', { dataTransfer: { files: [file] } });
    await tick(); await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="asset-kyc.selfie"]').text()).toContain('id.png');
    expect(uploadProvider.assets.size).toBe(1);
    controller.dispose(); wrapper.unmount();
  });

  it('capability negotiation passes for shared examples', () => {
    for (const name of ['contact.vds.json', 'customer-registration.vds.json', 'invoice.vds.json', 'kyc-documents.vds.json']) {
      expect(compileForm(load(name), { target: VUE_CAPABILITY_MANIFEST }).ok, name).toBe(true);
    }
  });

  it('unmount cleans up subscriptions (no leaks)', async () => {
    const { controller, wrapper } = await mountForm('contact.vds.json');
    wrapper.unmount();
    // After unmount, mutating the controller must not throw (listeners removed).
    expect(() => controller.setFieldValue('name', 'After unmount')).not.toThrow();
    controller.dispose();
  });
});

describe('Vue upload correctness (shared semantics)', () => {
  const failing = (bad: string) => ({
    scheme: 'test',
    async upload(req: { asset: { name: string; mimeType: string; sizeBytes: number } }) {
      if (req.asset.name === bad) throw new Error(`boom ${bad}`);
      return { assetRef: `ref-${req.asset.name}`, name: req.asset.name, mimeType: req.asset.mimeType, sizeBytes: req.asset.sizeBytes };
    },
  });
  const pdf = (n: string) => new File(['x'], n, { type: 'application/pdf' });

  it('keeps successful uploads when another file in the batch fails', async () => {
    const { controller, wrapper } = await mountForm('kyc-documents.vds.json', { uploadProvider: failing('b.pdf') as never });
    await wrapper.get('[data-testid="dropzone-kyc.proofDocs"]').trigger('drop', { dataTransfer: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
    await tick(); await wrapper.vm.$nextTick();
    const names = (controller.getFieldValue('kyc.proofDocs') as { name: string }[]).map((a) => a.name);
    expect(names).toEqual(['a.pdf', 'c.pdf']);
    expect(wrapper.get('[data-testid="upload-error-kyc.proofDocs"]').text()).toContain('b.pdf');
    controller.dispose(); wrapper.unmount();
  });

  it('preserves distinct same-name file selections instead of conflating them', async () => {
    const p = new TestUploadProvider();
    const { controller, wrapper } = await mountForm('kyc-documents.vds.json', { uploadProvider: p });
    const dz = wrapper.get('[data-testid="dropzone-kyc.proofDocs"]');
    await dz.trigger('drop', { dataTransfer: { files: [pdf('a.pdf')] } });
    await tick();
    await dz.trigger('drop', { dataTransfer: { files: [pdf('a.pdf')] } });
    await tick();
    expect(p.assets.size).toBe(2);
    expect((controller.getFieldValue('kyc.proofDocs') as unknown[]).length).toBe(2);
    controller.dispose(); wrapper.unmount();
  });
});
