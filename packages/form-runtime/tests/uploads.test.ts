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

  it('de-duplicates an identical asset already present (by reliable identity)', async () => {
    const { p, calls } = provider();
    const existing: UploadedAssetRef[] = [{ assetRef: 'r', name: 'a', mimeType: 'application/pdf', sizeBytes: 10 }];
    const r = await uploadAssetBatch({
      // Re-committing the SAME asset: it carries its asset ref, which is reliable
      // identity. A bare name+size match is deliberately NOT sufficient.
      files: [{ ...file('a', 10), assetRef: 'r' }], provider: p, multiple: true, source: 'picker',
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

describe('upload identity (no name:size collisions)', () => {
  it('preserves TWO DIFFERENT assets that share a name and size', async () => {
    // A real provider mints a distinct asset ref per upload.
    let n = 0; const calls: unknown[] = [];
    const p: UploadProvider = {
      scheme: 'test',
      async upload(req) {
        calls.push(req.asset); n += 1;
        return { assetRef: `ref-${n}`, name: req.asset.name, mimeType: req.asset.mimeType, sizeBytes: req.asset.sizeBytes };
      },
    };
    const commits: unknown[] = [];
    const r = await uploadAssetBatch({
      // Same name + size, but distinct reliable identities.
      files: [
        { name: 'scan.pdf', size: 10, type: 'application/pdf', lastModified: 1 },
        { name: 'scan.pdf', size: 10, type: 'application/pdf', lastModified: 2 },
      ],
      provider: p, multiple: true, source: 'picker', commit: (v) => commits.push(v),
    });
    expect(calls).toHaveLength(2);
    expect(r.uploaded).toHaveLength(2);
    expect((commits.at(-1) as UploadedAssetRef[])).toHaveLength(2);
  });

  it('preserves both files when NO reliable identity is available', async () => {
    const { p, calls } = provider();
    const r = await uploadAssetBatch({
      files: [{ name: 'scan.pdf', size: 10 }, { name: 'scan.pdf', size: 10 }],
      provider: p, multiple: true, source: 'picker', commit: () => {},
    });
    // Prefer preserving data over guessing identity from name:size.
    expect(calls).toHaveLength(2);
    expect(r.uploaded).toHaveLength(2);
  });

  it('de-duplicates by native picker id, local URI, fingerprint and asset ref', async () => {
    for (const extra of [{ id: 'n1' }, { localUri: 'file:///a' }, { fingerprint: 'sha256:abc' }, { assetRef: 'ref-x' }]) {
      const { p, calls } = provider();
      const seen = new Set<string>();
      const candidate = { name: 'a.pdf', size: 10, ...extra };
      await uploadAssetBatch({ files: [candidate], provider: p, multiple: true, source: 'picker', seenIdentities: seen, commit: () => {} });
      await uploadAssetBatch({ files: [candidate], provider: p, multiple: true, source: 'picker', seenIdentities: seen, commit: () => {} });
      expect(calls, JSON.stringify(extra)).toHaveLength(1);
    }
  });

  it('keeps existing asset references intact when appending', async () => {
    const { p } = provider();
    const existing: UploadedAssetRef[] = [{ assetRef: 'keep-1', name: 'old.pdf', mimeType: 'application/pdf', sizeBytes: 5 }];
    let last: unknown;
    await uploadAssetBatch({
      files: [{ name: 'new.pdf', size: 10, fingerprint: 'f1' }], provider: p, multiple: true,
      source: 'picker', currentValue: existing, commit: (v) => { last = v; },
    });
    expect((last as UploadedAssetRef[]).map((x) => x.assetRef)).toEqual(['keep-1', 'ref-new.pdf']);
  });

  it('repeated selection is deterministic across batches via the caller ledger', async () => {
    const { p, calls } = provider();
    const seen = new Set<string>();
    const same = { name: 'a.pdf', size: 10, lastModified: 12345 };
    for (let i = 0; i < 3; i++) {
      await uploadAssetBatch({ files: [same], provider: p, multiple: true, source: 'picker', seenIdentities: seen, commit: () => {} });
    }
    expect(calls).toHaveLength(1);
  });
});

describe('upload concurrency and disposal', () => {
  it('merges into the LIVE value instead of a stale snapshot', async () => {
    const { p } = provider();
    // Another valid update commits an asset while our transfer is in flight.
    let live: UploadedAssetRef[] = [{ assetRef: 'start', name: 'start.pdf', mimeType: 'application/pdf', sizeBytes: 1 }];
    const concurrent: UploadedAssetRef = { assetRef: 'concurrent', name: 'other.pdf', mimeType: 'application/pdf', sizeBytes: 2 };
    const slow: UploadProvider = {
      scheme: 'test',
      async upload() {
        live = [...live, concurrent]; // simulates a concurrent valid commit
        return { assetRef: 'mine', name: 'mine.pdf', mimeType: 'application/pdf', sizeBytes: 3 };
      },
    };
    let committed: UploadedAssetRef[] = [];
    await uploadAssetBatch({
      files: [{ name: 'mine.pdf', size: 3, fingerprint: 'm' }], provider: slow, multiple: true,
      source: 'picker', currentValue: live, readValue: () => live, commit: (v) => { committed = v as UploadedAssetRef[]; live = committed; },
    });
    expect(committed.map((r) => r.assetRef)).toEqual(['start', 'concurrent', 'mine']);
    expect(p).toBeDefined();
  });

  it('does not duplicate a ref already present in the live value', async () => {
    const dup: UploadedAssetRef = { assetRef: 'same', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1 };
    let live: UploadedAssetRef[] = [dup];
    const echo: UploadProvider = { scheme: 'test', async upload() { return dup; } };
    let committed: UploadedAssetRef[] = [];
    await uploadAssetBatch({
      files: [{ name: 'a.pdf', size: 1, fingerprint: 'x' }], provider: echo, multiple: true,
      source: 'picker', readValue: () => live, commit: (v) => { committed = v as UploadedAssetRef[]; },
    });
    expect(committed).toHaveLength(1);
  });

  it('never commits when the provider IGNORES the abort signal and resolves late', async () => {
    const ac = new AbortController();
    const commit = vi.fn();
    const stubborn: UploadProvider = {
      scheme: 'test',
      async upload() {
        ac.abort();
        await new Promise((r) => setTimeout(r, 5)); // ignores the signal
        return { assetRef: 'late', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1 };
      },
    };
    const r = await uploadAssetBatch({
      files: [{ name: 'a.pdf', size: 1 }], provider: stubborn, source: 'picker', signal: ac.signal, commit,
    });
    expect(r.cancelled).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('stops before starting the next file once aborted', async () => {
    const ac = new AbortController();
    const { p, calls } = provider(() => { ac.abort(); return 'ok'; });
    const r = await uploadAssetBatch({
      files: [{ name: 'a.pdf', size: 1 }, { name: 'b.pdf', size: 1 }], provider: p, multiple: true,
      source: 'picker', signal: ac.signal, commit: () => {},
    });
    expect(r.cancelled).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('upload uses the canonical accept rules', () => {
  it('accepts a .jpg file against a .jpg accept token (original defect)', async () => {
    const { p, calls } = provider();
    const r = await uploadAssetBatch({
      files: [{ name: 'photo.jpg', size: 10, type: 'image/jpeg' }], provider: p, source: 'picker',
      constraints: { accept: ['.jpg'] }, commit: () => {},
    });
    expect(r.failures).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('accepts a file with no MIME when the extension is known', async () => {
    const { p } = provider();
    const r = await uploadAssetBatch({
      files: [{ name: 'photo.jpg', size: 10 }], provider: p, source: 'picker',
      constraints: { accept: ['image/jpeg'] }, commit: () => {},
    });
    expect(r.failures).toEqual([]);
  });

  it('allows a file exactly at the size limit', async () => {
    const { p } = provider();
    const r = await uploadAssetBatch({
      files: [{ name: 'a.pdf', size: 100, type: 'application/pdf' }], provider: p, source: 'picker',
      constraints: { maxSizeBytes: 100 }, commit: () => {},
    });
    expect(r.failures).toEqual([]);
  });
});
