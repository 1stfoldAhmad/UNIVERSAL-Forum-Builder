/**
 * Shared upload-batch semantics (used by React, Vue, Angular and Expo).
 * These are the headless guarantees behind the renderers' partial-success tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { uploadAssetBatch, mimeAllowed } from '../src/uploads';
import type { NormalizedAsset, UploadedAssetRef, UploadProvider } from '@vds-form/types';

const file = (name: string, size = 10, type = 'application/pdf') => ({ name, size, type });

function provider(behaviour: (name: string, i: number) => 'ok' | 'fail' | 'hang' = () => 'ok') {
  const calls: NormalizedAsset[] = [];
  const p: UploadProvider = {
    scheme: 'test',
    async upload(req) {
      const i = calls.length;
      calls.push(req.asset);
      const b = behaviour(req.asset.name, i);
      if (b === 'fail') throw new Error(`boom ${req.asset.name}`);
      if (b === 'hang') {
        return new Promise<UploadedAssetRef>((_res, rej) => {
          req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return { assetRef: `ref-${req.asset.name}`, name: req.asset.name, mimeType: req.asset.mimeType, sizeBytes: req.asset.sizeBytes };
    },
  };
  return { p, calls };
}

describe('uploadAssetBatch', () => {
  it('commits after every success (not once at the end)', async () => {
    const { p } = provider();
    const commits: unknown[] = [];
    const r = await uploadAssetBatch({
      files: [file('a'), file('b'), file('c')], provider: p, multiple: true,
      source: 'picker', commit: (v) => commits.push(v),
    });
    expect(r.uploaded).toHaveLength(3);
    expect(commits).toHaveLength(3);
    expect((commits[0] as UploadedAssetRef[]).map((x) => x.name)).toEqual(['a']);
    expect((commits[2] as UploadedAssetRef[]).map((x) => x.name)).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['first', 'a', ['b', 'c']],
    ['middle', 'b', ['a', 'c']],
    ['last', 'c', ['a', 'b']],
  ])('preserves the other assets when the %s upload fails', async (_label, failing, expected) => {
    const { p } = provider((n) => (n === failing ? 'fail' : 'ok'));
    const commits: unknown[] = [];
    const r = await uploadAssetBatch({
      files: [file('a'), file('b'), file('c')], provider: p, multiple: true,
      source: 'drag-drop', commit: (v) => commits.push(v),
    });
    expect(r.uploaded.map((x) => x.name)).toEqual(expected);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ name: failing, code: 'UPLOAD_FAILED' });
    expect((commits.at(-1) as UploadedAssetRef[]).map((x) => x.name)).toEqual(expected);
  });

  it('preserves existing assets when appending', async () => {
    const { p } = provider();
    const existing: UploadedAssetRef[] = [{ assetRef: 'old', name: 'old', mimeType: 'application/pdf', sizeBytes: 1 }];
    let last: unknown;
    await uploadAssetBatch({
      files: [file('new')], provider: p, multiple: true, source: 'picker',
      currentValue: existing, commit: (v) => { last = v; },
    });
    expect((last as UploadedAssetRef[]).map((x) => x.name)).toEqual(['old', 'new']);
  });

  it('de-duplicates an identical asset already present', async () => {
    const { p, calls } = provider();
    const existing: UploadedAssetRef[] = [{ assetRef: 'r', name: 'a', mimeType: 'application/pdf', sizeBytes: 10 }];
    const r = await uploadAssetBatch({
      files: [file('a', 10)], provider: p, multiple: true, source: 'picker',
      currentValue: existing, commit: () => {},
    });
    expect(calls).toHaveLength(0);
    expect(r.uploaded).toHaveLength(0);
    expect(r.failures).toHaveLength(0);
  });

  it('trims extra files on a single-value field and reports them', async () => {
    const { p, calls } = provider();
    let last: unknown;
    const r = await uploadAssetBatch({
      files: [file('a'), file('b')], provider: p, multiple: false, source: 'picker',
      commit: (v) => { last = v; },
    });
    expect(calls).toHaveLength(1);
    expect((last as UploadedAssetRef).name).toBe('a');
    expect(r.failures[0]).toMatchObject({ name: 'b', code: 'MULTIPLE_NOT_ALLOWED' });
  });

  it('enforces size and MIME before calling the provider', async () => {
    const { p, calls } = provider();
    const r = await uploadAssetBatch({
      files: [file('big.pdf', 999), file('bad.png', 1, 'image/png')], provider: p, multiple: true,
      constraints: { accept: ['application/pdf'], maxSizeBytes: 100 }, source: 'picker', commit: () => {},
    });
    expect(calls).toHaveLength(0);
    expect(r.failures.map((f) => f.code)).toEqual(['ASSET_TOO_LARGE', 'ASSET_TYPE_REJECTED']);
  });

  it('reports a missing provider without throwing', async () => {
    const r = await uploadAssetBatch({ files: [file('a')], source: 'picker', commit: () => {} });
    expect(r.failures[0].code).toBe('UPLOAD_PROVIDER_MISSING');
  });

  it('stops on cancellation and keeps what was already committed', async () => {
    const ac = new AbortController();
    const { p } = provider((n) => (n === 'b' ? 'hang' : 'ok'));
    const commits: unknown[] = [];
    const promise = uploadAssetBatch({
      files: [file('a'), file('b'), file('c')], provider: p, multiple: true, source: 'picker',
      signal: ac.signal, commit: (v) => commits.push(v),
    });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const r = await promise;
    expect(r.cancelled).toBe(true);
    expect(r.uploaded.map((x) => x.name)).toEqual(['a']);
    expect((commits.at(-1) as UploadedAssetRef[]).map((x) => x.name)).toEqual(['a']);
  });

  it('never commits the in-flight result of a cancelled batch', async () => {
    const ac = new AbortController();
    const commit = vi.fn();
    const slow: UploadProvider = {
      scheme: 'test',
      async upload() {
        ac.abort(); // abort while the transfer is in flight
        return { assetRef: 'late', name: 'a', mimeType: 'application/pdf', sizeBytes: 10 };
      },
    };
    const r = await uploadAssetBatch({ files: [file('a')], provider: slow, source: 'picker', signal: ac.signal, commit });
    expect(r.cancelled).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('preserves native asset id/localUri/source and attributes the batch source', async () => {
    const { p, calls } = provider();
    await uploadAssetBatch({
      files: [{ name: 'cam.jpg', size: 5, type: 'image/jpeg', id: 'native-1', localUri: 'file:///tmp/cam.jpg', source: 'camera' }],
      provider: p, source: 'picker', commit: () => {},
    });
    expect(calls[0]).toMatchObject({ id: 'native-1', localUri: 'file:///tmp/cam.jpg', source: 'camera' });

    await uploadAssetBatch({ files: [file('drop.pdf')], provider: p, source: 'drag-drop', commit: () => {} });
    expect(calls[1].source).toBe('drag-drop');
  });

  it('emits progress with per-file and overall counters', async () => {
    const { p } = provider();
    const seen: { completed: number; total: number; fileName: string | null }[] = [];
    await uploadAssetBatch({
      files: [file('a'), file('b')], provider: p, multiple: true, source: 'picker',
      commit: () => {}, onProgress: (x) => seen.push({ completed: x.completed, total: x.total, fileName: x.fileName }),
    });
    expect(seen[0]).toMatchObject({ total: 2, fileName: 'a' });
    expect(seen.at(-1)).toMatchObject({ completed: 2, fileName: null });
  });
});

describe('mimeAllowed', () => {
  it('matches exact types, wildcards and extensions like server validation', () => {
    expect(mimeAllowed('image/png', ['image/png'])).toBe(true);
    expect(mimeAllowed('image/png', ['image/*'])).toBe(true);
    expect(mimeAllowed('application/pdf', ['.pdf'])).toBe(true);
    expect(mimeAllowed('image/png', ['application/pdf'])).toBe(false);
    expect(mimeAllowed('image/png', undefined)).toBe(true);
    expect(mimeAllowed('image/png', [])).toBe(true);
  });
});
