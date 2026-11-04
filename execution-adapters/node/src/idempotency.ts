/**
 * Atomic idempotency storage for the trusted Node execution adapter.
 *
 * Security properties (audit finding 3):
 * - Keys are scoped by tenant + user + form + operation, so one principal can
 *   never read or replay another principal's cached result.
 * - Every claim carries a canonical payload fingerprint (SHA-256). Reusing a
 *   key with a different payload is a conflict, never a silent replay.
 * - `claim` is atomic: concurrent requests with the same scoped key cannot all
 *   execute. The first claims; the rest see `in-progress` or `replay`.
 * - The store is a contract: hosts plug in a durable database-backed store.
 *   `SqliteIdempotencyStore` is a durable reference implementation (node:sqlite,
 *   Node >= 22.5); `InMemoryIdempotencyStore` is for single-process/dev use and
 *   is explicitly NOT durable across restarts.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { SubmissionResult } from '@vds-form/types';

const require = createRequire(import.meta.url);

/** Canonical JSON: recursively sorted object keys, no whitespace, UTF-8. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function payloadFingerprint(values: unknown): string {
  return createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex');
}

/** Scoped idempotency key: tenant|user|form|operation|clientKey, hashed. */
export function scopedIdempotencyKey(parts: {
  tenantId?: string; userId?: string; formId: string; operationRef: string; idempotencyKey: string;
}): string {
  return createHash('sha256').update(canonicalJson([
    parts.tenantId ?? '', parts.userId ?? '', parts.formId, parts.operationRef, parts.idempotencyKey,
  ]), 'utf8').digest('hex');
}

export const DEFAULT_IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;

export interface IdempotencyClaimOptions { leaseMs?: number; now?: number }

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; result: SubmissionResult }
  | { kind: 'conflict' }
  | { kind: 'in-progress' }
  | { kind: 'expired'; claimedAt: number; leaseExpiresAt: number };

/** Host integration contract for abandoned claims. The store NEVER re-executes
 * an expired claim automatically: the host must reconcile the operation outcome
 * (transaction/outbox) and then `complete` with the known result or `release`
 * only when the operation provably did not commit. */
export interface IdempotencyRecoveryContract {
  reconcile(key: string, fingerprint: string): Promise<{ committed: true; result: SubmissionResult } | { committed: false }>;
}

export interface IdempotencyStore {
  /** Atomically claim a scoped key for a payload fingerprint. */
  claim(key: string, fingerprint: string, opts?: IdempotencyClaimOptions): IdempotencyClaim | Promise<IdempotencyClaim>;
  /** Record the successful result for a claimed key. */
  complete(key: string, result: SubmissionResult): void | Promise<void>;
  /** Release an in-progress claim after a failed execution so retries can run. */
  release(key: string): void | Promise<void>;
}

interface Record_ { fingerprint: string; status: 'in-progress' | 'complete'; result?: SubmissionResult; claimedAt: number; leaseExpiresAt: number }

/** Single-process atomic store (JS event loop makes claim/complete/release atomic). NOT durable. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, Record_>();
  claim(key: string, fingerprint: string, opts: IdempotencyClaimOptions = {}): IdempotencyClaim {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? DEFAULT_IDEMPOTENCY_LEASE_MS;
    const rec = this.records.get(key);
    if (!rec) { this.records.set(key, { fingerprint, status: 'in-progress', claimedAt: now, leaseExpiresAt: leaseMs > 0 ? now + leaseMs : 0 }); return { kind: 'claimed' }; }
    if (rec.fingerprint !== fingerprint) return { kind: 'conflict' };
    if (rec.status === 'complete' && rec.result) return { kind: 'replay', result: rec.result };
    if (rec.leaseExpiresAt > 0 && now > rec.leaseExpiresAt) return { kind: 'expired', claimedAt: rec.claimedAt, leaseExpiresAt: rec.leaseExpiresAt };
    return { kind: 'in-progress' };
  }
  complete(key: string, result: SubmissionResult): void {
    const rec = this.records.get(key);
    if (rec) { rec.status = 'complete'; rec.result = result; }
  }
  release(key: string): void {
    const rec = this.records.get(key);
    if (rec && rec.status === 'in-progress') this.records.delete(key);
  }
}

/**
 * Durable reference store backed by SQLite (node:sqlite, Node >= 22.5).
 * The UNIQUE primary key makes claim atomic across processes; WAL mode allows
 * concurrent readers. Production hosts may substitute Postgres/MySQL via the
 * IdempotencyStore contract (INSERT .. ON CONFLICT / unique violation handling).
 */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private db: import('node:sqlite').DatabaseSync;
  constructor(path: string) {
    // Lazy require so Node < 22.5 hosts can still use the in-memory store.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS vds_form_idempotency (
      key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in-progress','complete')),
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at INTEGER NOT NULL DEFAULT 0,
      lease_expires_at INTEGER NOT NULL DEFAULT 0
    )`);
    for (const col of ['claimed_at INTEGER NOT NULL DEFAULT 0', 'lease_expires_at INTEGER NOT NULL DEFAULT 0']) {
      try { this.db.exec(`ALTER TABLE vds_form_idempotency ADD COLUMN ${col}`); } catch { /* already present */ }
    }
  }
  claim(key: string, fingerprint: string, opts: IdempotencyClaimOptions = {}): IdempotencyClaim {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? DEFAULT_IDEMPOTENCY_LEASE_MS;
    const leaseExpiresAt = leaseMs > 0 ? now + leaseMs : 0;
    try {
      this.db.prepare(`INSERT INTO vds_form_idempotency (key, fingerprint, status, claimed_at, lease_expires_at) VALUES (?, ?, 'in-progress', ?, ?)`).run(key, fingerprint, now, leaseExpiresAt);
      return { kind: 'claimed' };
    } catch {
      const row = this.db.prepare(`SELECT fingerprint, status, result_json, claimed_at, lease_expires_at FROM vds_form_idempotency WHERE key = ?`).get(key) as
        | { fingerprint: string; status: string; result_json: string | null; claimed_at: number; lease_expires_at: number } | undefined;
      if (!row) return { kind: 'in-progress' };
      if (row.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (row.status === 'complete' && row.result_json) return { kind: 'replay', result: JSON.parse(row.result_json) as SubmissionResult };
      if (row.lease_expires_at > 0 && now > row.lease_expires_at) return { kind: 'expired', claimedAt: row.claimed_at, leaseExpiresAt: row.lease_expires_at };
      return { kind: 'in-progress' };
    }
  }
  complete(key: string, result: SubmissionResult): void {
    this.db.prepare(`UPDATE vds_form_idempotency SET status = 'complete', result_json = ? WHERE key = ?`).run(JSON.stringify(result), key);
  }
  release(key: string): void {
    this.db.prepare(`DELETE FROM vds_form_idempotency WHERE key = ? AND status = 'in-progress'`).run(key);
  }
  close(): void { this.db.close(); }
}
