/**
 * Shared, framework-free upload-batch semantics for EVERY UI renderer.
 *
 * Before this module existed each renderer (React/Vue/Angular/Expo) accumulated
 * refs in a local array and committed them to the controller only AFTER the whole
 * batch finished. A single rejected file therefore discarded every asset that had
 * already uploaded successfully. These are the corrected, shared rules:
 *
 *  1. Each successful upload is committed IMMEDIATELY, so a later failure never
 *     discards earlier successes (partial success is preserved).
 *  2. Existing assets are preserved when appending to a multi-value field.
 *  3. Failures are reported per file; the batch continues past a failure.
 *  4. MIME/size constraints are enforced BEFORE calling the provider, using the
 *     same issue codes as server-side validation (ASSET_TYPE_REJECTED /
 *     ASSET_TOO_LARGE / MULTIPLE_NOT_ALLOWED) so client and server agree.
 *  5. Re-picking an identical asset (same name + size) is de-duplicated instead of
 *     uploaded twice.
 *  6. Cancellation is cooperative: an aborted signal stops the batch, keeps what
 *     was already committed, and never commits the in-flight result.
 *  7. The asset `source` reflects the real interaction (picker vs drag-drop).
 *
 * This module performs no I/O itself: the host-injected UploadProvider does the
 * transfer, and `commit` writes through the renderer's controller.
 */
import type { AuthContext, UploadProvider, UploadedAssetRef } from '@vds-form/types';

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
}

export interface UploadFailure {
  name: string;
  code: string;
  message: string;
}

export interface UploadProgress {
  /** Files considered by this batch (after single-value trimming). */
  total: number;
  /** Files finished (uploaded, skipped or failed). */
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
  /** Current field value, used to append and to de-duplicate. */
  currentValue?: unknown;
  auth?: AuthContext;
  signal?: AbortSignal;
  /** Called after EVERY successful upload (and never for a cancelled batch). */
  commit: (value: UploadedAssetRef | UploadedAssetRef[] | null) => void;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadBatchResult {
  uploaded: UploadedAssetRef[];
  failures: UploadFailure[];
  cancelled: boolean;
}

/** Mirrors the accept-matching rules used by @vds-form/validation. */
export function mimeAllowed(mimeType: string, accept?: string[]): boolean {
  if (!accept || accept.length === 0) return true;
  return accept.some((acc) =>
    acc === mimeType
    || (acc.endsWith('/*') && mimeType.startsWith(acc.slice(0, -1)))
    || (acc.startsWith('.') && mimeType.includes(acc.slice(1))));
}

function asRefArray(value: unknown): UploadedAssetRef[] {
  if (Array.isArray(value)) return value.filter((v): v is UploadedAssetRef => !!v && typeof v === 'object');
  if (value && typeof value === 'object') return [value as UploadedAssetRef];
  return [];
}

const assetKey = (name: string, size: number): string => `${name}:${size}`;

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

  const existing = multiple ? asRefArray(opts.currentValue) : [];
  const seen = new Set(existing.map((r) => assetKey(r.name, r.sizeBytes)));
  let accumulated: UploadedAssetRef[] = [...existing];
  let completed = 0;

  const emit = (index: number, fileName: string | null, fraction: number): void => {
    opts.onProgress?.({ total: files.length, completed, index, fileName, fraction });
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (opts.signal?.aborted) return { uploaded, failures, cancelled: true };

    const mimeType = file.type || 'application/octet-stream';
    emit(i, file.name, 0);

    if (opts.constraints?.maxSizeBytes !== undefined && file.size > opts.constraints.maxSizeBytes) {
      failures.push({ name: file.name, code: 'ASSET_TOO_LARGE', message: `File exceeds ${opts.constraints.maxSizeBytes} bytes.` });
      completed++; emit(i, file.name, 0);
      continue;
    }
    if (!mimeAllowed(mimeType, opts.constraints?.accept)) {
      failures.push({ name: file.name, code: 'ASSET_TYPE_REJECTED', message: `File type ${mimeType} is not allowed.` });
      completed++; emit(i, file.name, 0);
      continue;
    }
    const key = assetKey(file.name, file.size);
    if (seen.has(key)) {
      // Already uploaded in this field: do not repeat the upload operation.
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
      // An obsolete/cancelled batch must not write its result into the form.
      if (opts.signal?.aborted) return { uploaded, failures, cancelled: true };

      seen.add(key);
      uploaded.push(ref);
      if (multiple) {
        accumulated = [...accumulated, ref];
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
