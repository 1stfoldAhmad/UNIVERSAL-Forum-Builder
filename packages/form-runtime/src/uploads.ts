/**
 * Shared, framework-free upload-batch semantics for EVERY UI renderer.
 *
 * Rules (see also docs/audit/FINAL_COMPLETION_AUDIT_2026.md):
 *  1. Each successful upload is committed IMMEDIATELY, so a later failure never
 *     discards earlier successes (partial success is preserved).
 *  2. Commits merge into the LIVE field value, so a concurrent valid update is
 *     never clobbered by a stale snapshot taken when the batch started.
 *  3. Failures are reported per file; the batch continues past a failure.
 *  4. MIME/extension/size constraints use the canonical
 *     `@vds-form/validation` asset rules, so browser, Expo and the trusted
 *     server adapters agree (ASSET_TYPE_REJECTED / ASSET_TOO_LARGE /
 *     MULTIPLE_NOT_ALLOWED).
 *  5. De-duplication uses RELIABLE identity only (asset ref, native picker id,
 *     local URI, content fingerprint, or browser file identity). Two different
 *     files that merely share a name and size are BOTH preserved. When no
 *     reliable identity exists we never discard an item.
 *  6. Cancellation is cooperative: an aborted signal stops the batch, keeps what
 *     was already committed, and never commits the in-flight result — even if
 *     the provider ignores the signal and resolves later.
 *  7. The asset `source` reflects the real interaction (picker/drag-drop/camera).
 *
 * This module performs no I/O: the host-injected UploadProvider transfers, and
 * `commit` writes through the renderer's controller.
 */
import type { AuthContext, UploadProvider, UploadedAssetRef } from '@vds-form/types';
import { assetSizeAllowed, assetTypeAllowed } from '@vds-form/validation';

export type UploadSource = 'picker' | 'drag-drop' | 'camera';

/** Minimal structural file shape (browser File, RN asset, Angular/Vue wrapper). */
export interface UploadCandidate {
  name: string;
  size: number;
  type?: string;
  /** Native pickers already mint an id / local handle / source; preserve them. */
  id?: string;
  localUri?: string;
  source?: UploadSource;
  /** Set when the candidate is an already-uploaded asset. */
  assetRef?: string;
  /** Caller-computed content fingerprint (e.g. SHA-256), when available. */
  fingerprint?: string;
  /** Browser File.lastModified — part of reliable browser file identity. */
  lastModified?: number;
}

export interface UploadFailure {
  name: string;
  code: string;
  message: string;
}

export interface UploadProgress {
  total: number;
  completed: number;
  /** Zero-based index of the file currently transferring, or -1 when idle. */
  index: number;
  fileName: string | null;
  /** Progress of the current file, 0..1. */
  fraction: number;
}

export interface UploadBatchOptions {
  files: readonly UploadCandidate[];
  provider?: UploadProvider;
  constraints?: { accept?: string[]; maxSizeBytes?: number };
  multiple?: boolean;
  source: UploadSource;
  /** Snapshot used to seed de-duplication and as a merge fallback. */
  currentValue?: unknown;
  /**
   * Reads the LIVE field value at commit time. Strongly preferred over
   * `currentValue`: it prevents a long batch from overwriting assets that
   * another valid update committed while a transfer was in flight.
   */
  readValue?: () => unknown;
  auth?: AuthContext;
  signal?: AbortSignal;
  /**
   * Caller-owned ledger of identities already uploaded for this field. Pass a
   * stable Set (per field/component) to de-duplicate repeated selections across
   * batches. The batch adds to it as uploads succeed.
   */
  seenIdentities?: Set<string>;
  /** Called after EVERY successful upload (and never for a cancelled batch). */
  commit: (value: UploadedAssetRef | UploadedAssetRef[] | null) => void;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadBatchResult {
  uploaded: UploadedAssetRef[];
  failures: UploadFailure[];
  cancelled: boolean;
}

/**
 * Reliable identity for de-duplication, or null when none exists.
 * Deliberately does NOT fall back to `name:size` — that collides for distinct
 * files and would silently discard user data.
 */
export function uploadIdentity(c: UploadCandidate): string | null {
  if (c.assetRef) return `ref:${c.assetRef}`;
  if (c.id) return `id:${c.id}`;
  if (c.localUri) return `uri:${c.localUri}`;
  if (c.fingerprint) return `fp:${c.fingerprint}`;
  if (typeof c.lastModified === 'number' && Number.isFinite(c.lastModified)) {
    return `file:${c.name}:${c.size}:${c.lastModified}`;
  }
  return null;
}

function asRefArray(value: unknown): UploadedAssetRef[] {
  if (Array.isArray(value)) return value.filter((v): v is UploadedAssetRef => !!v && typeof v === 'object');
  if (value && typeof value === 'object') return [value as UploadedAssetRef];
  return [];
}

function isAbortError(e: unknown): boolean {
  const err = e as { name?: string; code?: string };
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 'UPLOAD_CANCELLED';
}

/**
 * Upload a batch of files with partial-success preservation.
 * Never throws for per-file failures; they are returned in `failures`.
 */
export async function uploadAssetBatch(opts: UploadBatchOptions): Promise<UploadBatchResult> {
  const failures: UploadFailure[] = [];
  const uploaded: UploadedAssetRef[] = [];
  const multiple = opts.multiple === true;
  const all = Array.from(opts.files ?? []);

  if (!opts.provider) {
    return {
      uploaded, cancelled: false,
      failures: [{ name: all[0]?.name ?? '', code: 'UPLOAD_PROVIDER_MISSING', message: 'No upload provider registered.' }],
    };
  }
  if (all.length === 0) return { uploaded, failures, cancelled: false };

  // Single-value fields accept only the first file; the rest are reported, not silently dropped.
  const files = multiple ? all : all.slice(0, 1);
  if (!multiple) {
    for (const extra of all.slice(1)) {
      failures.push({ name: extra.name, code: 'MULTIPLE_NOT_ALLOWED', message: 'Only one file is allowed.' });
    }
  }

  const existing = asRefArray(opts.currentValue);
  const seen = opts.seenIdentities ?? new Set<string>();
  for (const r of existing) if (r.assetRef) seen.add(`ref:${r.assetRef}`);

  let accumulated: UploadedAssetRef[] = multiple ? [...existing] : [];
  let completed = 0;

  const emit = (index: number, fileName: string | null, fraction: number): void => {
    opts.onProgress?.({ total: files.length, completed, index, fileName, fraction });
  };
  const liveRefs = (): UploadedAssetRef[] => (opts.readValue ? asRefArray(opts.readValue()) : accumulated);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (opts.signal?.aborted) return { uploaded, failures, cancelled: true };

    const mimeType = file.type || 'application/octet-stream';
    emit(i, file.name, 0);

    if (!assetSizeAllowed(file.size, opts.constraints?.maxSizeBytes)) {
      failures.push({ name: file.name, code: 'ASSET_TOO_LARGE', message: `File exceeds ${opts.constraints?.maxSizeBytes} bytes.` });
      completed++; emit(i, file.name, 0);
      continue;
    }
    // Pass BOTH the filename and the MIME: extensions match the name, MIME
    // tokens match the normalized MIME, and either can be inferred from the other.
    if (!assetTypeAllowed({ name: file.name, mimeType: file.type }, opts.constraints?.accept)) {
      failures.push({ name: file.name, code: 'ASSET_TYPE_REJECTED', message: `File type ${mimeType} is not allowed.` });
      completed++; emit(i, file.name, 0);
      continue;
    }

    const identity = uploadIdentity(file);
    if (identity !== null && seen.has(identity)) {
      // Same reliable asset already uploaded: do not repeat the operation.
      completed++; emit(i, file.name, 1);
      continue;
    }

    try {
      const ref = await opts.provider.upload({
        asset: {
          id: file.id ?? `${file.name}-${file.size}`,
          name: file.name,
          mimeType,
          sizeBytes: file.size,
          source: file.source ?? opts.source,
          ...(file.localUri !== undefined ? { localUri: file.localUri } : {}),
        },
        constraints: opts.constraints,
        signal: opts.signal,
        onProgress: (fraction) => emit(i, file.name, fraction),
        auth: opts.auth,
      });
      // An obsolete/cancelled batch must not write its result into the form,
      // even when the provider ignored the abort signal and resolved anyway.
      if (opts.signal?.aborted) return { uploaded, failures, cancelled: true };

      if (identity !== null) seen.add(identity);
      uploaded.push(ref);
      if (multiple) {
        // Merge into the LIVE value so concurrent valid updates survive.
        const live = liveRefs();
        accumulated = live.some((r) => r.assetRef === ref.assetRef) ? live : [...live, ref];
        opts.commit(accumulated);
      } else {
        opts.commit(ref);
      }
      completed++; emit(i, file.name, 1);
    } catch (e) {
      if (opts.signal?.aborted || isAbortError(e)) return { uploaded, failures, cancelled: true };
      failures.push({ name: file.name, code: 'UPLOAD_FAILED', message: (e as Error)?.message ?? 'Upload failed.' });
      completed++; emit(i, file.name, 0);
    }
  }

  opts.onProgress?.({ total: files.length, completed, index: -1, fileName: null, fraction: 1 });
  return { uploaded, failures, cancelled: false };
}

/**
 * MIME-only convenience check retained for callers that have no filename.
 * Delegates to the canonical rule, so an extension token can still match via
 * the MIME's well-known extensions (`.pdf` matches `application/pdf`).
 * Prefer `assetTypeAllowed({ name, mimeType }, accept)` when a filename exists.
 */
export function mimeAllowed(mimeType: string, accept?: string[]): boolean {
  return assetTypeAllowed({ mimeType }, accept);
}
