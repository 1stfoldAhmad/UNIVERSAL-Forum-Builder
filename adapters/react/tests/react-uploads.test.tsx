/**
 * Phase 1 — React upload correctness.
 *
 * The previous implementation committed refs only after the whole batch, so one
 * rejected file discarded every already-uploaded asset. These tests lock the
 * corrected behaviour: incremental commit, per-file errors, real source
 * attribution, cancellation and de-duplication.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import type { FormIR, NormalizedAsset, UploadedAssetRef, UploadProvider } from '@vds-form/types';
import { UniversalForm } from '../src/index';

const irOf = (name: string): FormIR => {
  const doc = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
  const r = compileForm(doc);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};

type Behaviour = 'ok' | 'fail' | 'hang';

/** TEST provider: scripted per-file outcome, records the real asset source. */
class ScriptedUploadProvider implements UploadProvider {
  readonly scheme = 'test';
  calls: { name: string; source: string }[] = [];
  constructor(private behaviour: (name: string, index: number) => Behaviour = () => 'ok') {}

  async upload(req: {
    asset: NormalizedAsset;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  }): Promise<UploadedAssetRef> {
    const index = this.calls.length;
    this.calls.push({ name: req.asset.name, source: req.asset.source });
    if (req.signal?.aborted) throw Object.assign(new Error('UPLOAD_CANCELLED'), { name: 'AbortError' });
    const b = this.behaviour(req.asset.name, index);
    if (b === 'fail') throw new Error(`UPLOAD_FAILED: ${req.asset.name}`);
    if (b === 'hang') {
      return new Promise<UploadedAssetRef>((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(Object.assign(new Error('UPLOAD_CANCELLED'), { name: 'AbortError' })));
      });
    }
    req.onProgress?.(1);
    return { assetRef: `ref-${req.asset.name}`, name: req.asset.name, mimeType: req.asset.mimeType, sizeBytes: req.asset.sizeBytes };
  }
}

const pdf = (name: string, bytes = 10) => new File(['x'.repeat(bytes)], name, { type: 'application/pdf' });
const png = (name: string, bytes = 10) => new File(['x'.repeat(bytes)], name, { type: 'image/png' });

async function mount(provider?: UploadProvider) {
  const controller = new FormController({ ir: irOf('kyc-documents.vds.json'), uploadProvider: provider });
  await controller.initialize();
  const utils = render(<UniversalForm controller={controller} />);
  return { controller, ...utils };
}

const drop = async (path: string, files: File[]) => {
  await act(async () => { fireEvent.drop(screen.getByTestId(`dropzone-${path}`), { dataTransfer: { files } }); });
};
const pick = async (path: string, files: File[]) => {
  await act(async () => { fireEvent.change(screen.getByTestId(`file-input-${path}`), { target: { files } }); });
};
const names = (v: unknown) => (Array.isArray(v) ? v.map((a) => (a as UploadedAssetRef).name) : []);
const errors = (path: string) => screen.queryAllByTestId(`upload-error-${path}`).map((e) => e.textContent ?? '');

describe('React upload correctness', () => {
  it('uploads a single file', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    await pick('kyc.idDocument', [pdf('id.pdf')]);
    await waitFor(() => expect(screen.getByTestId('asset-kyc.idDocument').textContent).toContain('id.pdf'));
    expect((controller.getFieldValue('kyc.idDocument') as UploadedAssetRef).assetRef).toBe('ref-id.pdf');
    controller.dispose();
  });

  it('uploads multiple files', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf', 'b.pdf', 'c.pdf']));
    expect(p.calls).toHaveLength(3);
    controller.dispose();
  });

  it('keeps later successes when the FIRST upload fails', async () => {
    const p = new ScriptedUploadProvider((n) => (n === 'a.pdf' ? 'fail' : 'ok'));
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['b.pdf', 'c.pdf']));
    expect(errors('kyc.proofDocs').join(' ')).toContain('a.pdf');
    controller.dispose();
  });

  it('keeps surrounding successes when a MIDDLE upload fails', async () => {
    const p = new ScriptedUploadProvider((n) => (n === 'b.pdf' ? 'fail' : 'ok'));
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf', 'c.pdf']));
    expect(errors('kyc.proofDocs')).toHaveLength(1);
    controller.dispose();
  });

  it('keeps earlier successes when the LAST upload fails', async () => {
    const p = new ScriptedUploadProvider((n) => (n === 'c.pdf' ? 'fail' : 'ok'));
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf', 'b.pdf']));
    expect(errors('kyc.proofDocs').join(' ')).toContain('c.pdf');
    controller.dispose();
  });

  it('reports every failure individually on partial success', async () => {
    const p = new ScriptedUploadProvider((n) => (n === 'b.pdf' ? 'ok' : 'fail'));
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['b.pdf']));
    const msgs = errors('kyc.proofDocs');
    expect(msgs).toHaveLength(2);
    expect(msgs.join(' ')).toContain('a.pdf');
    expect(msgs.join(' ')).toContain('c.pdf');
    expect(msgs.every((m) => m.includes('UPLOAD_FAILED'))).toBe(true);
    controller.dispose();
  });

  it('attributes picker uploads to the picker source', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    await pick('kyc.idDocument', [pdf('picked.pdf')]);
    await waitFor(() => expect(p.calls).toHaveLength(1));
    expect(p.calls[0].source).toBe('picker');
    controller.dispose();
  });

  it('attributes drag-and-drop uploads to the drag-drop source', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    await drop('kyc.idDocument', [pdf('dropped.pdf')]);
    await waitFor(() => expect(p.calls).toHaveLength(1));
    expect(p.calls[0].source).toBe('drag-drop');
    controller.dispose();
  });

  it('cancels an in-flight upload without discarding committed assets', async () => {
    const p = new ScriptedUploadProvider((n) => (n === 'b.pdf' ? 'hang' : 'ok'));
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf'), pdf('b.pdf')]);
    await waitFor(() => expect(screen.getByTestId('cancel-upload-kyc.proofDocs')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-upload-kyc.proofDocs')); });
    await waitFor(() => expect(screen.queryByTestId('cancel-upload-kyc.proofDocs')).toBeNull());
    // 'a.pdf' completed before cancellation and must survive.
    expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf']);
    controller.dispose();
  });

  it('does not re-upload the same file on a repeated interaction', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    // Re-selecting the SAME file yields the same File identity (lastModified).
    const same = pdf('a.pdf');
    await drop('kyc.proofDocs', [same]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf']));
    await drop('kyc.proofDocs', [same]);
    expect(p.calls).toHaveLength(1); // de-duplicated by reliable identity
    expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf']);
    controller.dispose();
  });

  it('preserves existing assets when adding more in a later interaction', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf')]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf']));
    await drop('kyc.proofDocs', [pdf('b.pdf')]);
    await waitFor(() => expect(names(controller.getFieldValue('kyc.proofDocs'))).toEqual(['a.pdf', 'b.pdf']));
    controller.dispose();
  });

  it('rejects a disallowed MIME type before calling the provider', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    await drop('kyc.proofDocs', [png('not-allowed.png')]);
    await waitFor(() => expect(errors('kyc.proofDocs').join(' ')).toContain('ASSET_TYPE_REJECTED'));
    expect(p.calls).toHaveLength(0);
    expect(controller.getFieldValue('kyc.proofDocs') ?? []).toEqual([]);
    controller.dispose();
  });

  it('rejects an oversized file before calling the provider', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 });
    await drop('kyc.proofDocs', [big]);
    await waitFor(() => expect(errors('kyc.proofDocs').join(' ')).toContain('ASSET_TOO_LARGE'));
    expect(p.calls).toHaveLength(0);
    controller.dispose();
  });

  it('reports extra files on a single-value field instead of dropping them silently', async () => {
    const p = new ScriptedUploadProvider();
    const { controller } = await mount(p);
    await drop('kyc.idDocument', [pdf('one.pdf'), pdf('two.pdf')]);
    await waitFor(() => expect(errors('kyc.idDocument').join(' ')).toContain('MULTIPLE_NOT_ALLOWED'));
    expect(p.calls).toHaveLength(1);
    expect((controller.getFieldValue('kyc.idDocument') as UploadedAssetRef).name).toBe('one.pdf');
    controller.dispose();
  });

  it('surfaces a missing upload provider', async () => {
    const { controller } = await mount(undefined);
    await drop('kyc.proofDocs', [pdf('a.pdf')]);
    await waitFor(() => expect(errors('kyc.proofDocs').join(' ')).toContain('UPLOAD_PROVIDER_MISSING'));
    controller.dispose();
  });

  it('aborts in-flight uploads on unmount', async () => {
    const p = new ScriptedUploadProvider(() => 'hang');
    const { controller, unmount } = await mount(p);
    await drop('kyc.proofDocs', [pdf('a.pdf')]);
    await waitFor(() => expect(screen.getByTestId('cancel-upload-kyc.proofDocs')).toBeTruthy());
    unmount();
    // No value was committed and the controller is still usable/disposable.
    expect(controller.getFieldValue('kyc.proofDocs') ?? []).toEqual([]);
    controller.dispose();
  });
});
