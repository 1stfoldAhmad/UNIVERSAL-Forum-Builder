import { describe, expect, it } from 'vitest';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import { MemoryDraftStorage, MemoryOfflineQueue } from '@vds-form/persistence';
import { SubmissionExecutorRegistry, replayOfflineQueue } from '@vds-form/submission';
import { TestOperationExecutor, succeeded } from '@vds-form/vds-contracts';
import type { DraftEnvelope, FormDocument, FormIR } from '@vds-form/types';

function doc(overrides: Partial<FormDocument> = {}): FormDocument {
  return {
    format: 'vds.form', specVersion: '1.0.0', id: 'sensitive-form',
    metadata: { name: 'Sensitive' },
    fields: [
      { id: 'username', type: 'text', key: 'username', label: 'Username', required: true },
      { id: 'password', type: 'password', key: 'password', label: 'Password', required: true },
      { id: 'apiToken', type: 'password', key: 'apiToken', label: 'API token' },
    ],
    submission: { operationRef: 'test:submit', offline: { queue: true } },
    persistence: { drafts: { enabled: true }, offline: { enabled: true } },
    ...overrides,
  } as FormDocument;
}
function irOf(d: FormDocument): FormIR {
  const r = compileForm(d);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
}
const executor = new TestOperationExecutor('test', {
  'test:submit': (ctx) => ctx.values.password
    ? succeeded('test:submit', { ok: true }, ctx)
    : { status: 'server-validation-failed', issues: [{ code: 'REQUIRED', message: 'password required', path: 'password', severity: 'error', source: 'server' }] },
});
function registry() { const r = new SubmissionExecutorRegistry(); r.register(executor); return r; }

describe('sensitive persistence boundaries', () => {
  it('drafts exclude registry-sensitive fields by default and restore without them', async () => {
    const drafts = new MemoryDraftStorage();
    const controller = new FormController({ ir: irOf(doc()), drafts, executors: registry() });
    await controller.initialize();
    controller.setFieldValue('username', 'ada');
    controller.setFieldValue('password', 'secret');
    controller.setFieldValue('apiToken', 'tok');
    await controller.saveDraft();
    const saved = await drafts.load('sensitive-form', 'device:device') as DraftEnvelope;
    expect(saved.values).toEqual({ username: 'ada' });
    const restored = new FormController({ ir: irOf(doc()), drafts, executors: registry() });
    await restored.initialize();
    expect(restored.getFieldValue('username')).toBe('ada');
    expect(restored.getFieldValue('password')).toBeNull();
    expect(restored.getFieldValue('apiToken')).toBeNull();
    controller.dispose(); restored.dispose();
  });

  it('drafts persist sensitive fields only with explicit opt-in', async () => {
    const drafts = new MemoryDraftStorage();
    const d = doc(); d.persistence = { drafts: { enabled: true, includeSensitive: true }, offline: { enabled: true } };
    const controller = new FormController({ ir: irOf(d), drafts, executors: registry() });
    await controller.initialize();
    controller.setFieldValue('password', 'secret');
    await controller.saveDraft();
    const saved = await drafts.load('sensitive-form', 'device:device') as DraftEnvelope;
    expect(saved.values.password).toBe('secret');
    controller.dispose();
  });

  it('offline queue excludes sensitive fields by default; replay fails safely when server requires them', async () => {
    const queue = new MemoryOfflineQueue();
    const controller = new FormController({ ir: irOf(doc()), offlineQueue: queue, executors: registry(), isOnline: () => false });
    await controller.initialize();
    controller.setFieldValue('username', 'ada');
    controller.setFieldValue('password', 'secret');
    controller.setFieldValue('apiToken', 'tok');
    const result = await controller.submit();
    expect(result.status).toBe('queued-offline');
    const records = await queue.list('device:device');
    expect(records).toHaveLength(1);
    expect(records[0].values).toEqual({ username: 'ada' });
    const replay = await replayOfflineQueue(records, registry(), (id, patch) => queue.update(id, patch));
    expect(replay.conflicted).toEqual([records[0].id]);
    const after = await queue.list('device:device');
    expect(after[0].status).toBe('conflict');
    controller.dispose();
  });

  it('offline queue includes sensitive fields only with explicit opt-in and replays successfully', async () => {
    const queue = new MemoryOfflineQueue();
    const d = doc(); d.persistence = { drafts: { enabled: true }, offline: { enabled: true, includeSensitive: true } };
    const controller = new FormController({ ir: irOf(d), offlineQueue: queue, executors: registry(), isOnline: () => false });
    await controller.initialize();
    controller.setFieldValue('username', 'ada');
    controller.setFieldValue('password', 'secret');
    const result = await controller.submit();
    expect(result.status).toBe('queued-offline');
    const records = await queue.list('device:device');
    expect(records[0].values.password).toBe('secret');
    const replay = await replayOfflineQueue(records, registry(), (id, patch) => queue.update(id, patch));
    expect(replay.sent).toEqual([records[0].id]);
    controller.dispose();
  });

  it('draft save failure is surfaced and does not report saved', async () => {
    const drafts = new MemoryDraftStorage();
    drafts.save = async () => { throw new Error('disk full'); };
    const controller = new FormController({ ir: irOf(doc()), drafts, executors: registry() });
    await controller.initialize();
    await controller.saveDraft();
    expect(controller.getSnapshot().draft.status).toBe('error');
    controller.dispose();
  });

  it('queue enqueue failure is surfaced and does not report queued', async () => {
    const queue = new MemoryOfflineQueue();
    queue.enqueue = async () => { throw new Error('queue unavailable'); };
    const controller = new FormController({ ir: irOf(doc()), offlineQueue: queue, executors: registry(), isOnline: () => false });
    await controller.initialize();
    controller.setFieldValue('username', 'ada');
    controller.setFieldValue('password', 'secret');
    const result = await controller.submit();
    expect(result.status).toBe('config-error');
    if (result.status === 'config-error') expect(result.code).toBe('OFFLINE_QUEUE_NOT_PERMITTED');
    expect(await queue.list('device:device')).toEqual([]);
    controller.dispose();
  });
});
