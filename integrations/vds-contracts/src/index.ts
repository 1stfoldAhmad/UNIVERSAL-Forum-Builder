/**
 * @vds-form/vds-contracts — provider contracts for VDS builders whose source is
 * not publicly available (Phase 0 discovery: no Database/API/Storage/Notification
 * builder repos exist). This package ships:
 *   1. The integration contract shapes (aligned with expo-app-foundation auth contracts).
 *   2. Explicitly-named TEST adapters that prove the contracts end-to-end.
 * Test adapters are NEVER presented as production VDS integrations.
 */
import type {
  AuthContext, DataSourceProvider, DataSourceRequest, DataSourceResponse,
  ExecutorContract, NormalizedAsset, RbacEvaluator, SubmissionAction,
  SubmissionContext, SubmissionExecutor, SubmissionResult, UploadProvider, UploadedAssetRef,
} from '@vds-form/types';

/* ---------------- auth context (expo-app-foundation-aligned) ---------------- */

/** Map session claims (AuthProviderAdapter/AuthSession shape) to a form AuthContext. */
export function authContextFromClaims(claims: {
  sub?: string; tenant_id?: string; roles?: string[]; permissions?: string[]; sid?: string;
}): AuthContext {
  return {
    userId: claims.sub, tenantId: claims.tenant_id,
    roles: claims.roles ?? [], permissions: claims.permissions ?? [], sessionId: claims.sid,
  };
}

/** Simple permission-subset RBAC evaluator (host projects replace with their policy engine). */
export class SimpleRbacEvaluator implements RbacEvaluator {
  evaluate(auth: AuthContext | undefined, required: string[]): { allowed: boolean; missing: string[] } {
    const granted = new Set(auth?.permissions ?? []);
    if (granted.has('*')) return { allowed: true, missing: [] };
    const missing = required.filter((p) => !granted.has(p));
    return { allowed: missing.length === 0, missing };
  }
}

/* ---------------- TEST submission executor ---------------- */

export type TestOperationHandler = (ctx: SubmissionContext) => SubmissionResult | Promise<SubmissionResult>;

/**
 * Explicitly-named TEST executor: operations are registered handlers with real
 * execution paths (in-memory persistence, validation, rejection). Proves the
 * submission contract; not a production integration.
 */
export class TestOperationExecutor implements SubmissionExecutor {
  readonly contract: ExecutorContract;
  private idempotency = new Map<string, SubmissionResult>();
  constructor(
    readonly scheme: string = 'test',
    private operations: Record<string, TestOperationHandler> = {},
    contract: Partial<ExecutorContract> = {},
  ) {
    this.contract = { supportsOfflineQueue: true, idempotent: true, trusted: false, ...contract };
  }
  register(operationRef: string, handler: TestOperationHandler): void {
    this.operations[operationRef] = handler;
  }
  supports(action: SubmissionAction): boolean {
    return Object.hasOwn(this.operations, action.operationRef);
  }
  async execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult> {
    const cached = this.idempotency.get(context.idempotencyKey);
    if (cached && this.contract.idempotent) return cached;
    const handler = this.operations[action.operationRef];
    if (!handler) {
      return { status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED', message: `Test operation "${action.operationRef}" is not registered.` };
    }
    const result = await handler(context);
    if (result.status === 'succeeded' && this.contract.idempotent) {
      this.idempotency.set(context.idempotencyKey, result);
    }
    return result;
  }
}

/** Helper: wrap plain data as a succeeded result. */
export const succeeded = (operationRef: string, data: unknown, ctx: SubmissionContext, durationMs = 0): SubmissionResult =>
  ({ status: 'succeeded', operationRef, data, idempotencyKey: ctx.idempotencyKey, durationMs });

/* ---------------- TEST data source provider ---------------- */

export type TestQueryHandler = (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown[]> | unknown[];

export class TestDataSourceProvider implements DataSourceProvider {
  constructor(readonly scheme: string = 'test', private handlers: Record<string, TestQueryHandler> = {}) {}
  register(providerRef: string, handler: TestQueryHandler): void { this.handlers[providerRef] = handler; }
  async query(request: DataSourceRequest): Promise<DataSourceResponse> {
    const handler = this.handlers[request.providerRef];
    if (!handler) throw new Error(`TEST_PROVIDER_OPERATION_UNRESOLVED: ${request.providerRef}`);
    if (request.signal?.aborted) throw new Error('ABORTED');
    const items = await handler(request.params, request.signal);
    return { items };
  }
}

/* ---------------- TEST upload provider (Storage Builder contract) ---------------- */

export class TestUploadProvider implements UploadProvider {
  readonly scheme = 'test';
  readonly assets = new Map<string, { asset: NormalizedAsset; ref: UploadedAssetRef }>();
  private counter = 0;
  async upload(request: {
    asset: NormalizedAsset;
    constraints?: { accept?: string[]; maxSizeBytes?: number };
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
    auth?: AuthContext;
  }): Promise<UploadedAssetRef> {
    const { asset, constraints } = request;
    if (request.signal?.aborted) throw new Error('UPLOAD_CANCELLED');
    if (constraints?.maxSizeBytes !== undefined && asset.sizeBytes > constraints.maxSizeBytes) {
      throw new Error(`ASSET_TOO_LARGE: ${asset.sizeBytes} > ${constraints.maxSizeBytes}`);
    }
    if (constraints?.accept?.length && !constraints.accept.some((a) => a === asset.mimeType || (a.endsWith('/*') && asset.mimeType.startsWith(a.slice(0, -1))))) {
      throw new Error(`ASSET_TYPE_REJECTED: ${asset.mimeType}`);
    }
    request.onProgress?.(0.5);
    this.counter += 1;
    const ref: UploadedAssetRef = {
      assetRef: `test-asset-${this.counter}`, name: asset.name,
      mimeType: asset.mimeType, sizeBytes: asset.sizeBytes,
    };
    request.onProgress?.(1);
    this.assets.set(ref.assetRef, { asset, ref });
    return ref;
  }
}

/* ---------------- in-memory "database" for examples/tests ---------------- */

/** Tiny in-memory record store used by TEST operations to prove real persistence paths. */
export class InMemoryRecordStore {
  private tables = new Map<string, Map<string, Record<string, unknown>>>();
  create(table: string, values: Record<string, unknown>, id?: string): Record<string, unknown> {
    const t = this.tables.get(table) ?? new Map<string, Record<string, unknown>>();
    const recordId = id ?? `rec-${t.size + 1}`;
    const record = { id: recordId, ...values, createdAt: new Date().toISOString() };
    t.set(recordId, record);
    this.tables.set(table, t);
    return record;
  }
  get(table: string, id: string): Record<string, unknown> | undefined { return this.tables.get(table)?.get(id); }
  list(table: string): Record<string, unknown>[] { return [...(this.tables.get(table)?.values() ?? [])]; }
  findBy(table: string, key: string, value: unknown): Record<string, unknown> | undefined {
    return this.list(table).find((r) => r[key] === value);
  }
}
