import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import { TestOperationExecutor, TestUploadProvider, succeeded } from '@vds-form/vds-contracts';
import type { FormIR, NormalizedAsset } from '@vds-form/types';
import { ExpoForm, createExpoCapabilityManifest } from '../src/index';

const load = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const irOf = (name: string): FormIR => {
  const r = compileForm(load(name));
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};

async function mount(name: string, extra: Partial<ConstructorParameters<typeof FormController>[0]> = {}, pickers = {}) {
  const controller = new FormController({ ir: irOf(name), ...extra });
  await controller.initialize();
  const utils = render(<ExpoForm controller={controller} pickers={pickers} />);
  return { controller, ...utils };
}

describe('Expo renderer (React Native primitives via react-native-web test alias)', () => {
  it('renders a contact form with native inputs and submits through a registered executor', async () => {
    const exec = new TestOperationExecutor('test', {
      'test:contact.create': (ctx) => succeeded('test:contact.create', { id: 'c1', ...ctx.values }, ctx),
    });
    const executors = new SubmissionExecutorRegistry();
    executors.register(exec);
    const { controller } = await mount('contact.vds.json', { executors });

    fireEvent.change(screen.getByTestId('input-name'), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByTestId('input-email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByTestId('input-message'), { target: { value: 'Hello from the Expo renderer test.' } });
    await act(async () => { fireEvent.click(screen.getByTestId('submit-button')); });
    await waitFor(() => expect(screen.getByTestId('submit-success')).toBeTruthy());
    expect(exec.supports({ operationRef: 'test:contact.create' })).toBe(true);
    expect(controller.getState()).toBe('submission-succeeded');
    controller.dispose();
  });

  it('shows validation errors accessibly and blocks invalid submission', async () => {
    const { controller } = await mount('contact.vds.json', {
      executors: (() => { const r = new SubmissionExecutorRegistry(); r.register(new TestOperationExecutor('test', { 'test:contact.create': (ctx) => succeeded('test:contact.create', {}, ctx) })); return r; })(),
    });
    await act(async () => { fireEvent.click(screen.getByTestId('submit-button')); });
    await waitFor(() => expect(screen.getByTestId('error-summary')).toBeTruthy());
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(controller.getState()).toBe('invalid');
    controller.dispose();
  });

  it('conditional fields appear/disappear with select changes', async () => {
    const { controller } = await mount('customer-registration.vds.json');
    expect(screen.queryByTestId('input-customer.companyName')).toBeNull();
    fireEvent.click(screen.getByTestId('select-customer.type'));
    await waitFor(() => expect(screen.getByTestId('option-customer.type-business')).toBeTruthy());
    fireEvent.click(screen.getByTestId('option-customer.type-business'));
    await waitFor(() => expect(screen.getByTestId('input-customer.companyName')).toBeTruthy());
    expect(controller.getSnapshot().required.companyName).toBe(true);
    controller.dispose();
  });

  it('repeater rows render with stable identity; add/remove/move work', async () => {
    const { controller } = await mount('invoice.vds.json');
    fireEvent.click(screen.getByTestId('add-items'));
    fireEvent.click(screen.getByTestId('add-items'));
    const rowIds = controller.getRowIds('items');
    expect(rowIds.length).toBe(2);
    expect(screen.getByTestId(`row-items-${rowIds[0]}`)).toBeTruthy();
    fireEvent.change(screen.getByTestId('input-items.0.description'), { target: { value: 'Widget' } });
    fireEvent.change(screen.getByTestId('input-items.0.qty'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('input-items.0.price'), { target: { value: '10' } });
    await waitFor(() => expect(screen.getByTestId('computed-items.0.lineTotal').textContent).toContain('20'));
    expect(screen.getByTestId('computed-total').textContent).toContain('23'); // 20 + 15% tax
    // Move row 0 down; identity follows.
    fireEvent.click(screen.getByTestId(`move-down-${rowIds[0]}`));
    expect(controller.getRowIds('items')[1]).toBe(rowIds[0]);
    expect(screen.getByTestId(`row-items-${rowIds[0]}`)).toBeTruthy();
    // Remove the other row.
    fireEvent.click(screen.getByTestId(`remove-${rowIds[1]}`));
    expect(controller.getRowIds('items')).toEqual([rowIds[0]]);
    controller.dispose();
  });

  it('file field uploads through injected native picker + registered upload provider', async () => {
    const uploadProvider = new TestUploadProvider();
    const asset: NormalizedAsset = { id: 'a1', name: 'id.png', mimeType: 'image/png', sizeBytes: 1024, source: 'picker', localUri: 'file:///tmp/id.png' };
    const pickers = { pickImage: vi.fn(async () => asset), pickDocument: vi.fn(async () => [asset]) };
    const { controller } = await mount('kyc-documents.vds.json', { uploadProvider }, pickers);
    fireEvent.click(screen.getByTestId('pick-kyc.selfie'));
    await waitFor(() => expect(screen.getByTestId('asset-kyc.selfie').textContent).toContain('id.png'));
    expect(pickers.pickImage).toHaveBeenCalled();
    expect(uploadProvider.assets.size).toBe(1);
    const value = controller.getFieldValue('kyc.selfie') as { assetRef: string };
    expect(value.assetRef).toBe('test-asset-1');
    controller.dispose();
  });

  it('file field without picker adapters shows structured unsupported state (no fake)', async () => {
    const { controller } = await mount('kyc-documents.vds.json');
    expect(screen.getByTestId('unsupported-kyc.selfie').textContent).toContain('unavailable');
    expect(screen.queryByTestId('pick-kyc.selfie')).toBeNull();
    controller.dispose();
  });

  it('multi-step wizard gates progression on step validation', async () => {
    const { controller } = await mount('job-application.vds.json');
    expect(screen.getByTestId('wizard')).toBeTruthy();
    expect(screen.getByTestId('input-applicant.name')).toBeTruthy();
    // Try to advance with empty required fields → blocked (wait for validation to settle).
    await act(async () => { fireEvent.click(screen.getByTestId('wizard-next')); });
    await waitFor(() => expect(controller.getState()).toBe('invalid'));
    expect(screen.getByTestId('input-applicant.name')).toBeTruthy();
    fireEvent.change(screen.getByTestId('input-applicant.name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByTestId('input-applicant.email'), { target: { value: 'ada@example.com' } });
    await act(async () => { fireEvent.click(screen.getByTestId('wizard-next')); });
    await waitFor(() => expect(screen.getByTestId('select-application.position')).toBeTruthy());
    controller.dispose();
  });

  it('capability manifest is honest about pickers and unsupported types', () => {
    const bare = createExpoCapabilityManifest();
    expect(bare.features.filePicker).toBe(false);
    expect(bare.features.camera).toBe(false);
    expect(bare.features.signature).toBe(false);
    expect(bare.fieldTypes.signature).toBeUndefined();
    const withPickers = createExpoCapabilityManifest({ pickImage: async () => null });
    expect(withPickers.features.filePicker).toBe(true);
    // Compiler negotiation: KYC form fails on bare manifest, passes with pickers.
    const kyc = load('kyc-documents.vds.json');
    const bad = compileForm(kyc, { target: bare });
    expect(bad.ok).toBe(false);
    const good = compileForm(kyc, { target: withPickers });
    expect(good.ok).toBe(true);
  });

  it('accessibility roles/labels are present on native controls', async () => {
    const { controller } = await mount('customer-registration.vds.json');
    const consent = screen.getByTestId('checkbox-customer.consent');
    expect(consent.getAttribute('role')).toBe('checkbox');
    const email = screen.getByTestId('input-customer.email');
    expect(email.getAttribute('aria-label') ?? email.getAttribute('accessibilityLabel')).toBeTruthy();
    controller.dispose();
  });
});
