/**
 * Durable SQLite draft/offline persistence for the trusted Node adapter.
 * Uses node:sqlite (Node >= 22.5). These are real durable reference adapters:
 * data survives process restarts. Browser/Expo hosts use the KeyValueStore
 * adapters in @vds-form/persistence instead.
 */
import { createRequire } from 'node:module';
import type { DraftEnvelope, DraftStorageAdapter, OfflineQueueAdapter, QueuedSubmissionRecord } from '@vds-form/types';

const require = createRequire(import.meta.url);

export class SqliteDraftStorage implements DraftStorageAdapter {
  private db: import('node:sqlite').DatabaseSync;
  constructor(path: string) {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS vds_form_drafts (
      form_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      PRIMARY KEY (form_id, scope_key)
    )`);
  }
  async save(envelope: DraftEnvelope): Promise<void> {
    this.db.prepare(`INSERT INTO vds_form_drafts (form_id, scope_key, envelope_json) VALUES (?, ?, ?)
      ON CONFLICT(form_id, scope_key) DO UPDATE SET envelope_json = excluded.envelope_json`)
      .run(envelope.formId, envelope.scopeKey, JSON.stringify(envelope));
  }
  async load(formId: string, scopeKey: string): Promise<DraftEnvelope | null> {
    const row = this.db.prepare('SELECT envelope_json FROM vds_form_drafts WHERE form_id = ? AND scope_key = ?').get(formId, scopeKey) as { envelope_json: string } | undefined;
    if (!row) return null;
    const e = JSON.parse(row.envelope_json) as DraftEnvelope;
    if (e.expiresAt && Date.parse(e.expiresAt) < Date.now()) { await this.clear(formId, scopeKey); return null; }
    return e;
  }
  async clear(formId: string, scopeKey: string): Promise<void> {
    this.db.prepare('DELETE FROM vds_form_drafts WHERE form_id = ? AND scope_key = ?').run(formId, scopeKey);
  }
  close(): void { this.db.close(); }
}

export class SqliteOfflineQueue implements OfflineQueueAdapter {
  private db: import('node:sqlite').DatabaseSync;
  constructor(path: string) {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS vds_form_queue (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL
    )`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS vds_form_queue_active_key
      ON vds_form_queue(scope_key, idempotency_key) WHERE status NOT IN ('sent','cancelled')`);
  }
  async enqueue(record: QueuedSubmissionRecord): Promise<void> {
    try {
      this.db.prepare('INSERT INTO vds_form_queue (id, scope_key, idempotency_key, status, record_json) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.scopeKey, record.idempotencyKey, record.status, JSON.stringify(record));
    } catch (e) {
      throw new Error(`QUEUE_DUPLICATE: idempotency key already queued (${record.idempotencyKey}).`);
    }
  }
  async list(scopeKey: string): Promise<QueuedSubmissionRecord[]> {
    const rows = this.db.prepare('SELECT record_json FROM vds_form_queue WHERE scope_key = ?').all(scopeKey) as Array<{ record_json: string }>;
    return rows.map((r) => JSON.parse(r.record_json) as QueuedSubmissionRecord);
  }
  async update(id: string, patch: Partial<QueuedSubmissionRecord>): Promise<void> {
    const row = this.db.prepare('SELECT record_json FROM vds_form_queue WHERE id = ?').get(id) as { record_json: string } | undefined;
    if (!row) throw new Error(`QUEUE_RECORD_NOT_FOUND: ${id}`);
    const r = JSON.parse(row.record_json) as QueuedSubmissionRecord;
    const next = { ...r, ...patch, id: r.id, scopeKey: r.scopeKey };
    this.db.prepare('UPDATE vds_form_queue SET status = ?, record_json = ? WHERE id = ?').run(next.status, JSON.stringify(next), id);
  }
  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM vds_form_queue WHERE id = ?').run(id);
  }
  close(): void { this.db.close(); }
}
