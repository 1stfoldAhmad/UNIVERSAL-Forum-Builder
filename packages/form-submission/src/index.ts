/**
 * @vds-form/submission — real operation delegation contracts.
 * There is NO generic endpoint and NO default executor. Missing registrations fail
 * with structured configuration errors (spec §2.4 / §11).
 */
import type {
  FormIR, FormValues, QueuedSubmissionRecord, SubmissionAction, SubmissionContext,
  SubmissionDef, SubmissionExecutor, SubmissionResult, ValidationIssue,
} from '@vds-form/types';
import { getPath } from '@vds-form/expressions';
import type { EffectiveFieldState } from '@vds-form/validation';

export class SubmissionExecutorRegistry {
  private executors = new Map<string, SubmissionExecutor>();

  register(executor: SubmissionExecutor): void {
    if (!/^[a-z][a-z0-9-]*$/.test(executor.scheme)) {
      throw new Error(`EXECUTOR_SCHEME_INVALID: "${executor.scheme}"`);
    }
    if (this.executors.has(executor.scheme)) {
      throw new Error(`EXECUTOR_DUPLICATE: scheme "${executor.scheme}" already registered.`);
    }
    this.executors.set(executor.scheme, executor);
  }
  get(scheme: string): SubmissionExecutor | undefined { return this.executors.get(scheme); }
  forRef(operationRef: string): SubmissionExecutor | undefined {
    const scheme = operationRef.split(':')[0];
    return this.executors.get(scheme);
  }
  schemes(): string[] { return [...this.executors.keys()].sort(); }
  knownOperations(): string[] { return this.schemes(); }
}

export function schemeOf(operationRef: string): string {
  return operationRef.split(':')[0] ?? '';
}

/** Build the normalized, mapped submission payload from visible values. */
export function buildSubmissionPayload(
  ir: FormIR, values: FormValues, state: EffectiveFieldState, def: SubmissionDef,
): { payload: Record<string, unknown>; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const visibleValues: FormValues = {};
  const hiddenKeys = new Set(
    ir.fields.filter((f) => !def.includeHidden && state.visibility[f.id] === false).map((f) => f.key),
  );
  const isUnderHidden = (key: string) => [...hiddenKeys].some((h) => key === h || key.startsWith(`${h}.`) || key.startsWith(`${h}[`));
  for (const [k, v] of Object.entries(values)) {
    if (!isUnderHidden(k)) visibleValues[k] = v;
  }
  // Strip hidden nested keys recursively (shallow-top approach handles nested objects).
  const stripHidden = (obj: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (isUnderHidden(path)) continue;
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? stripHidden(v as Record<string, unknown>, path) : v;
    }
    return out;
  };
  const cleaned = stripHidden(visibleValues, '');

  let payload: Record<string, unknown>;
  if (def.inputMapping && Object.keys(def.inputMapping).length) {
    payload = {};
    for (const [param, sourcePath] of Object.entries(def.inputMapping)) {
      if (isUnderHidden(sourcePath)) continue;
      const v = getPath(cleaned, sourcePath);
      if (v === undefined) {
        issues.push({ code: 'MAPPING_SOURCE_MISSING', message: `Mapping source "${sourcePath}" has no value.`, path: sourcePath, severity: 'warning', source: 'schema' });
        continue;
      }
      payload[param] = v;
    }
  } else {
    payload = cleaned;
  }

  // Assets must be uploaded references before leaving the client.
  const checkAssets = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => checkAssets(x, `${path}.${i}`)); return; }
    if (v && typeof v === 'object') {
      const a = v as { assetRef?: string; localUri?: string; mimeType?: string };
      if (a.localUri !== undefined && a.assetRef === undefined) {
        issues.push({ code: 'ASSET_NOT_UPLOADED', message: 'Asset must be uploaded before submission.', path, severity: 'error', source: 'field' });
      }
    }
  };
  for (const f of ir.fields) {
    if (f.valueType === 'asset' || f.valueType === 'asset[]') {
      checkAssets(getPath(payload, f.key) ?? getPath(cleaned, f.key), f.key);
    }
  }
  return { payload, issues };
}

export function makeIdempotencyKey(
  def: SubmissionDef, formId: string, values: FormValues, newId: () => string,
): string {
  if (def.idempotency?.strategy === 'stable') {
    const parts = (def.idempotency.stableKeys ?? []).map((k) => `${k}=${JSON.stringify(getPath(values, k) ?? null)}`);
    let h = 0x811c9dc5;
    const s = `${formId}|${parts.join('|')}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `stable-${formId}-${h.toString(16).padStart(8, '0')}`;
  }
  return newId();
}

export const configError = (code: Extract<SubmissionResult, { status: 'config-error' }>['code'], message: string): SubmissionResult =>
  ({ status: 'config-error', code, message });

/** Resolve the executor for an action, producing explicit structured failures. */
export async function resolveExecutor(
  registry: SubmissionExecutorRegistry | undefined, action: SubmissionAction,
): Promise<{ executor: SubmissionExecutor } | { error: SubmissionResult }> {
  if (!registry) return { error: configError('SUBMISSION_EXECUTOR_NOT_REGISTERED', `No executor registry configured; cannot execute "${action.operationRef}".`) };
  const executor = registry.forRef(action.operationRef);
  if (!executor) return { error: configError('SUBMISSION_EXECUTOR_NOT_REGISTERED', `No executor registered for scheme "${schemeOf(action.operationRef)}" (operation "${action.operationRef}").`) };
  const supported = await executor.supports(action);
  if (!supported) return { error: configError('SUBMISSION_OPERATION_UNRESOLVED', `Executor "${executor.scheme}" does not resolve operation "${action.operationRef}".`) };
  return { executor };
}

/** Replay queued offline submissions through their registered executors. */
export async function replayOfflineQueue(
  records: QueuedSubmissionRecord[],
  registry: SubmissionExecutorRegistry,
  update: (id: string, patch: Partial<QueuedSubmissionRecord>) => Promise<void>,
  opts: { auth?: SubmissionContext['authenticatedContext']; maxAttempts?: number } = {},
): Promise<{ sent: string[]; failed: string[]; conflicted: string[] }> {
  const sent: string[] = []; const failed: string[] = []; const conflicted: string[] = [];
  for (const rec of records) {
    if (rec.status !== 'queued' && rec.status !== 'failed') continue;
    if (rec.attempts >= (opts.maxAttempts ?? rec.maxAttempts)) continue;
    const resolved = await resolveExecutor(registry, { operationRef: rec.operationRef, operationVersion: rec.operationVersion });
    if ('error' in resolved) {
      await update(rec.id, { status: 'failed', attempts: rec.attempts + 1, failure: { code: resolved.error.status === 'config-error' ? resolved.error.code : 'EXECUTION_ERROR', message: 'error' in resolved.error ? resolved.error.message : 'unknown' } });
      failed.push(rec.id);
      continue;
    }
    await update(rec.id, { status: 'sending', attempts: rec.attempts + 1 });
    const result = await resolved.executor.execute(
      { operationRef: rec.operationRef, operationVersion: rec.operationVersion },
      {
        formId: rec.formId, formVersion: rec.formVersion, specVersion: rec.specVersion,
        values: rec.values, authenticatedContext: opts.auth,
        idempotencyKey: rec.idempotencyKey, correlationId: `replay-${rec.id}`,
      },
    );
    if (result.status === 'succeeded') {
      await update(rec.id, { status: 'sent' });
      sent.push(rec.id);
    } else if (result.status === 'server-validation-failed' || result.status === 'business-rejected' || result.status === 'permission-denied') {
      await update(rec.id, { status: 'conflict', conflict: { reason: result.status, detectedAt: new Date().toISOString() }, failure: { code: result.status, message: 'message' in result ? result.message : result.status } });
      conflicted.push(rec.id);
    } else {
      const message = 'message' in result ? result.message : result.status;
      await update(rec.id, { status: 'failed', failure: { code: result.status, message } });
      failed.push(rec.id);
    }
  }
  return { sent, failed, conflicted };
}
