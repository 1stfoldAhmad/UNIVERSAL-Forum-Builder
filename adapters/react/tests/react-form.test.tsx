import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import { TestOperationExecutor, TestUploadProvider, succeeded } from '@vds-form/vds-contracts';
import type { FormIR } from '@vds-form/types';
import { UniversalForm, REACT_CAPABILITY_MANIFEST } from '../src/index';

const load = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const irOf = (name: string): FormIR => {
  const r = compileForm(load(name));
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};
const testExecutors = (op: string) => {
  const r = new SubmissionExecutorRegistry();
  r.register(new TestOperationExecutor('test', { [op]: (ctx) => succeeded(op, { id: 'x1', ...ctx.values }, ctx) }));
  return r;
};

async function mount(name: string, extra: Partial<ConstructorParameters<typeof FormController>[0]> = {}) {
  const controller = new FormController({ ir: irOf(name), ...extra });
  await controller.initialize();
  const utils = render(<UniversalForm controller={controller} />);
  return { controller, ...utils };
}

describe('React renderer', () => {
  it('renders accessible controls and submits the same canonical form', async () => {
    const { controller } = await mount('contact.vds.json', { executors: testExecutors('test:contact.create') });
    const name = screen.getByTestId('input-name');
    expect(name.getAttribute('id')).toBe('input-name');
    expect(screen.getByText('Full name').getAttribute('for')).toBe('input-name');
    fireEvent.change(name, { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByTestId('input-email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByTestId('input-message'), { target: { value: 'Hello from the React renderer.' } });
    await act(async () => { fireEvent.click(screen.getByTestId('submit-button')); });
    await waitFor(() => expect(screen.getByTestId('submit-success')).toBeTruthy());
    expect(controller.getState()).toBe('submission-succeeded');
    controller.dispose();
  });

  it('marks invalid fields with aria-invalid and aria-describedby', async () => {
    const { controller } = await mount('contact.vds.json', { executors: testExecutors('test:contact.create') });
    fireEvent.change(screen.getByTestId('input-email'), { target: { value: 'bad' } });
    fireEvent.blur(screen.getByTestId('input-email'));
    await waitFor(() => expect(screen.getByTestId('error-email')).toBeTruthy());
    const email = screen.getByTestId('input-email');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toContain('error-email');
    controller.dispose();
  });

  it('conditional business fields reveal and submit correctly', async () => {
    const { controller } = await mount('customer-registration.vds.json', { executors: testExecutors('test:customer.create') });
    expect(screen.queryByTestId('field-customer.companyName')).toBeNull();
    fireEvent.change(screen.getByTestId('input-customer.type'), { target: { value: 'business' } });
    await waitFor(() => expect(screen.getByTestId('input-customer.companyName')).toBeTruthy());
    fireEvent.change(screen.getByTestId('input-customer.name'), { target: { value: 'Grace Hopper' } });
    fireEvent.change(screen.getByTestId('input-customer.email'), { target: { value: 'grace@example.com' } });
    fireEvent.change(screen.getByTestId('input-customer.companyName'), { target: { value: 'Navy Labs' } });
    fireEvent.click(screen.getByTestId('input-customer.consent'));
    await act(async () => { fireEvent.click(screen.getByTestId('submit-button')); });
    await waitFor(() => expect(screen.getByTestId('submit-success')).toBeTruthy());
    controller.dispose();
  });

  it('invoice repeater computes totals live in the DOM', async () => {
    const { controller } = await mount('invoice.vds.json', { executors: testExecutors('test:invoice.create') });
    fireEvent.click(screen.getByTestId('add-items'));
    fireEvent.change(screen.getByTestId('input-items.0.description'), { target: { value: 'Widget' } });
    fireEvent.change(screen.getByTestId('input-items.0.qty'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('input-items.0.price'), { target: { value: '10' } });
    await waitFor(() => expect(screen.getByTestId('computed-items.0.lineTotal').textContent).toBe('30'));
    expect(screen.getByTestId('computed-total').textContent).toBe('34.5');
    controller.dispose();
  });

  it('supports drag-and-drop upload through the registered provider', async () => {
    const uploadProvider = new TestUploadProvider();
    const { controller } = await mount('kyc-documents.vds.json', { uploadProvider });
    const file = new File(['fake-png-bytes'], 'id.png', { type: 'image/png' });
    const dropzone = screen.getByTestId('dropzone-kyc.selfie');
    await act(async () => {
      fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId('asset-kyc.selfie').textContent).toContain('id.png'));
    expect(uploadProvider.assets.size).toBe(1);
    expect((controller.getFieldValue('kyc.selfie') as { assetRef: string }).assetRef).toBe('test-asset-1');
    controller.dispose();
  });

  it('rejects oversized uploads with a visible error (server contract mirrored)', async () => {
    const uploadProvider = new TestUploadProvider();
    const { controller } = await mount('kyc-documents.vds.json', { uploadProvider });
    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 });
    await act(async () => {
      fireEvent.drop(screen.getByTestId('dropzone-kyc.idDocument'), { dataTransfer: { files: [big] } });
    });
    await waitFor(() => expect(screen.getByTestId('upload-error-kyc.idDocument').textContent).toContain('ASSET_TOO_LARGE'));
    expect(uploadProvider.assets.size).toBe(0);
    controller.dispose();
  });

  it('capability negotiation passes for the shared examples', () => {
    for (const name of ['contact.vds.json', 'customer-registration.vds.json', 'invoice.vds.json', 'job-application.vds.json', 'kyc-documents.vds.json']) {
      const r = compileForm(load(name), { target: REACT_CAPABILITY_MANIFEST });
      expect(r.ok, name).toBe(true);
    }
  });

  it('nested groups render as fieldsets with correct paths', async () => {
    const { controller } = await mount('nested-profile.vds.json', { executors: testExecutors('test:profile.save') });
    expect(screen.getByTestId('group-profile')).toBeTruthy();
    fireEvent.change(screen.getByTestId('input-profile.displayName'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByTestId('input-profile.contact.email'), { target: { value: 'ada@example.com' } });
    expect(controller.getValues().profile).toEqual({ displayName: 'Ada', contact: { email: 'ada@example.com' } });
    controller.dispose();
  });
});
