/**
 * @vds-form/execution-node — trusted server-side execution adapter.
 * Framework-independent (no Express/Fastify assumptions). Re-validates and
 * re-authorizes EVERY submission; client-side hiding is never authorization.
 * Operations come from a registered OperationRegistry (Database/API Builder
 * contracts); there is no generic endpoint.
 *
 * SECURITY BOUNDARY (audit P0/P1):
 * - `auth` is a SEPARATE, server-derived argument. It is never read from the
 *   client request payload. HTTP adapters must derive it from the framework's
 *   authenticated principal or validated token claims — never from the body.
 * - The executed operation is bound to the compiled FormIR (and an optional
 *   server-side allowlist). A client cannot select or override the operation.
 * - Idempotency is checked only AFTER authentication, authorization and version
 *   checks; keys are scoped by tenant+user+form+operation and carry a canonical
 *   payload fingerprint; claims are atomic. See ./idempotency.ts.
 */
import type {
  AuthContext, FormDocument, FormIR, RbacEvaluator, SubmissionAction,
  SubmissionContext, SubmissionExecutor, SubmissionResult, ValidationIssue,
} from '@vds-form/types';
import { compileForm } from '@vds-form/compiler';
import { computeEffectiveState, computeReadPolicy, expandFieldInstances, filterReadableValues, prepareSubmissionValues, validateValues } from '@vds-form/validation';
import { buildSubmissionPayload } from '@vds-form/submission';
import { getPath, setIn } from '@vds-form/expressions';
import {
  InMemoryIdempotencyStore, payloadFingerprint, scopedIdempotencyKey,
  type IdempotencyStore,
} from './idempotency';

export { createNodeHttpHandler, createNodeHttpServer, type NodeHttpOptions } from './http';

export {
  InMemoryIdempotencyStore, SqliteIdempotencyStore,
  canonicalJson, payloadFingerprint, scopedIdempotencyKey,
  type IdempotencyStore, type IdempotencyClaim,
} from './idempotency';

export type OperationHandler = (
  payload: Record<string, unknown>,
  ctx: { auth?: AuthContext; idempotencyKey: string; correlationId: string; formId: string },
) => Promise<unknown> | unknown;

export class OperationRegistry {
  private handlers = new Map<string, OperationHandler>();
  register(operationRef: string, handler: OperationHandler): void {
    if (this.handlers.has(operationRef)) throw new Error(`OPERATION_DUPLICATE: ${operationRef}`);
    this.handlers.set(operationRef, handler);
  }
  has(operationRef: string): boolean { return this.handlers.has(operationRef); }
  resolve(operationRef: string): OperationHandler | undefined { return this.handlers.get(operationRef); }
  refs(): string[] { return [...this.handlers.keys()].sort(); }
}

export interface AuditEntry {
  timestamp: string;
  formId: string;
  formVersion: string;
  operationRef: string;
  correlationId: string;
  idempotencyKey: string;
  userId?: string;
  tenantId?: string;
  outcome: SubmissionResult['status'];
  issueCodes: string[];
  /** Paths only — never submitted values. */
  valuePaths: string[];
}
export type AuditSink = (entry: AuditEntry) => void;

export interface TrustedSubmissionRequest {
  formId: string;
  formVersion?: string;
  /** Mapped payload exactly as the client executor sent it. Never contains auth. */
  values: Record<string, unknown>;
  /**
   * Optional echo of the operation the client believes it is invoking. It is
   * validated against the compiled FormIR and rejected on mismatch; it can
   * never select or override the operation.
   */
  operationRef?: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface TrustedHandlerOptions {
  forms: Record<string, FormIR | FormDocument>;
  operations: OperationRegistry;
  rbac?: RbacEvaluator;
  audit?: AuditSink;
  /**
   * Pluggable idempotency store. Defaults to a single-process in-memory store
   * (NOT durable across restarts). Production hosts should inject a durable,
   * atomic database-backed store (e.g. SqliteIdempotencyStore or a host
   * Postgres/MySQL implementation of IdempotencyStore).
   */
  idempotencyStore?: IdempotencyStore;
  /**
   * Optional server-side allowlist of operation refs. When present, the form's
   * configured operation must be a member; otherwise the submission is denied.
   */
  allowedOperations?: string[];
}

const serverIssue = (code: string, message: string, path = ''): ValidationIssue =>
  ({ code, message, path, severity: 'error', source: 'server' });

export class TrustedSubmissionHandler {
  private irs = new Map<string, FormIR>();
  private idempotency: IdempotencyStore;
  private allowedOperations?: Set<string>;

  constructor(private options: TrustedHandlerOptions) {
    this.idempotency = options.idempotencyStore ?? new InMemoryIdempotencyStore();
    this.allowedOperations = options.allowedOperations ? new Set(options.allowedOperations) : undefined;
    for (const [id, form] of Object.entries(options.forms)) {
      if ((form as FormIR).irVersion !== undefined) {
        this.irs.set(id, form as FormIR);
      } else {
        const compiled = compileForm(form);
        if (!compiled.ok) throw new Error(`FORM_COMPILE_FAILED (${id}): ${compiled.diagnostics.map((d) => d.message).join('; ')}`);
        this.irs.set(id, compiled.ir);
      }
    }
  }

  supportsOperation(operationRef: string): boolean { return this.options.operations.has(operationRef); }

  /**
   * Handle a submission. `auth` is the SERVER-DERIVED principal (from the
   * framework's authenticated user or validated token claims). It must never be
   * taken from the client request body.
   */
  async handle(request: TrustedSubmissionRequest, auth?: AuthContext): Promise<SubmissionResult> {
    const started = Date.now();
    const ir = this.irs.get(request.formId);
    if (!ir) {
      return { status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED', message: `Form "${request.formId}" is not registered on this server.` };
    }

    // Operation binding: the operation comes from the compiled FormIR, never
    // from the client. A mismatching client echo is an override attempt.
    const operationRef = ir.submission?.operationRef ?? '';
    if (request.operationRef !== undefined && request.operationRef !== operationRef) {
      const result: SubmissionResult = { status: 'permission-denied', code: 'OPERATION_OVERRIDE_FORBIDDEN', message: 'The requested operation does not match the operation configured for this form.' };
      this.audit(ir, operationRef, request, auth, result, ['OPERATION_OVERRIDE_FORBIDDEN']);
      return result;
    }
    if (this.allowedOperations && !this.allowedOperations.has(operationRef)) {
      const result: SubmissionResult = { status: 'permission-denied', code: 'OPERATION_NOT_ALLOWED', message: `Operation "${operationRef}" is not in the server allowlist.` };
      this.audit(ir, operationRef, request, auth, result, ['OPERATION_NOT_ALLOWED']);
      return result;
    }

    if (request.formVersion && request.formVersion !== ir.formVersion) {
      const result: SubmissionResult = {
        status: 'server-validation-failed',
        issues: [serverIssue('FORM_VERSION_MISMATCH', `Client form version ${request.formVersion} ≠ server ${ir.formVersion}.`)],
      };
      this.audit(ir, operationRef, request, auth, result, ['FORM_VERSION_MISMATCH']);
      return result;
    }

    // Reconstruct field-keyed values for effective state, then apply the strict
    // submission policy (unknown roots, hidden descendants, typed operation
    // inputs) before validation/execution. The executed payload is rebuilt from
    // cleaned values — the raw request is never forwarded to an operation.
    let rawValues: Record<string, unknown> = {};
    const mapping = ir.submission?.inputMapping;
    if (mapping && Object.keys(mapping).length) {
      for (const [param, sourcePath] of Object.entries(mapping)) {
        if (Object.hasOwn(request.values, param)) rawValues = setIn(rawValues, sourcePath, request.values[param]);
      }
    } else {
      rawValues = request.values;
    }

    const { state } = computeEffectiveState(ir, rawValues);
    const prepared = prepareSubmissionValues(ir, request.values, state.visibility);
    if (prepared.issues.length) {
      const result: SubmissionResult = {
        status: 'server-validation-failed',
        issues: prepared.issues.map((i) => ({ ...i, source: 'server' as const })),
      };
      this.audit(ir, operationRef, request, auth, result, prepared.issues.map((i) => i.code));
      return result;
    }
    const values = prepared.fieldValues;

    // Server-side effective state + full re-validation (never trusts the client).
    const validation = validateValues(ir, values, state, { phase: 'submit' });
    if (!validation.valid) {
      const result: SubmissionResult = {
        status: 'server-validation-failed',
        issues: validation.issues.map((i) => ({ ...i, source: 'server' as const })),
      };
      this.audit(ir, operationRef, request, auth, result, validation.issues.map((i) => i.code));
      return result;
    }

    // Authorization: fail closed when permissions are declared but no evaluator
    // exists, and when a principal is required but absent.
    const required = ir.security.submitPermissions ?? [];
    if (required.length) {
      if (!this.options.rbac) {
        const result: SubmissionResult = { status: 'permission-denied', code: 'RBAC_NOT_CONFIGURED', message: 'Form declares submitPermissions but no RBAC evaluator is registered on the server.', requiredPermissions: required };
        this.audit(ir, operationRef, request, auth, result, ['RBAC_NOT_CONFIGURED']);
        return result;
      }
      const decision = this.options.rbac.evaluate(auth, required);
      if (!decision.allowed) {
        const result: SubmissionResult = { status: 'permission-denied', code: 'PERMISSION_DENIED', message: `Missing permissions: ${decision.missing.join(', ')}`, requiredPermissions: decision.missing };
        this.audit(ir, operationRef, request, auth, result, ['PERMISSION_DENIED']);
        return result;
      }
    }
    // Field-level write protection (concrete repeater instances, not templates).
    for (const [fieldId, access] of Object.entries(ir.security.fieldAccess ?? {})) {
      if (!access.write?.length) continue;
      const field = ir.fields.find((f) => f.id === fieldId);
      if (!field) continue;
      const instances = expandFieldInstances(ir, values).filter((i) => i.field.id === fieldId);
      const paths = instances.length ? instances.map((i) => i.concreteKey) : [field.key];
      for (const path of paths) {
        const provided = getPath(values, path);
        if (provided === undefined) continue;
        const decision = this.options.rbac?.evaluate(auth, access.write) ?? { allowed: false, missing: access.write };
        if (!decision.allowed) {
          const result: SubmissionResult = { status: 'permission-denied', code: 'FIELD_WRITE_DENIED', message: `Not permitted to write field "${path}".`, requiredPermissions: decision.missing };
          this.audit(ir, operationRef, request, auth, result, ['FIELD_WRITE_DENIED']);
          return result;
        }
      }
    }

    const readPolicy = computeReadPolicy(ir, auth, this.options.rbac);

    const payloadValues = { ...values, ...prepared.operationInputs };
    const built = buildSubmissionPayload(ir, payloadValues, state, ir.submission ?? { operationRef });
    const payloadErrors = built.issues.filter((i) => i.severity === 'error');
    if (payloadErrors.length) {
      const result: SubmissionResult = {
        status: 'server-validation-failed',
        issues: payloadErrors.map((i) => ({ ...i, source: 'server' as const })),
      };
      this.audit(ir, operationRef, request, auth, result, payloadErrors.map((i) => i.code));
      return result;
    }

    const handler = this.options.operations.resolve(operationRef);
    if (!handler) {
      const result: SubmissionResult = { status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED', message: `Operation "${operationRef}" is not registered on this server.` };
      this.audit(ir, operationRef, request, auth, result, ['SUBMISSION_OPERATION_UNRESOLVED']);
      return result;
    }

    // Idempotency AFTER auth/authz/version. Scoped key + payload fingerprint +
    // atomic claim prevent cross-principal replay, payload-swap and double-exec.
    const scopeKey = scopedIdempotencyKey({
      tenantId: auth?.tenantId, userId: auth?.userId,
      formId: ir.formId, operationRef, idempotencyKey: request.idempotencyKey,
    });
    const fingerprint = payloadFingerprint(request.values);
    const claim = await this.idempotency.claim(scopeKey, fingerprint);
    if (claim.kind === 'replay') {
      let replayResult = claim.result;
      if (replayResult.status === 'succeeded' && replayResult.data && typeof replayResult.data === 'object' && !Array.isArray(replayResult.data)) {
        replayResult = { ...replayResult, data: filterReadableValues(ir, replayResult.data as Record<string, unknown>, readPolicy.denied) };
      }
      this.audit(ir, operationRef, request, auth, replayResult, ['IDEMPOTENT_REPLAY']);
      return replayResult;
    }
    if (claim.kind === 'conflict') {
      const result: SubmissionResult = { status: 'business-rejected', code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'This idempotency key was already used with a different payload.' };
      this.audit(ir, operationRef, request, auth, result, ['IDEMPOTENCY_KEY_CONFLICT']);
      return result;
    }
    if (claim.kind === 'in-progress') {
      const result: SubmissionResult = { status: 'business-rejected', code: 'IDEMPOTENCY_IN_PROGRESS', message: 'A submission with this idempotency key is already in progress.' };
      this.audit(ir, operationRef, request, auth, result, ['IDEMPOTENCY_IN_PROGRESS']);
      return result;
    }
    if (claim.kind === 'expired') {
      const result: SubmissionResult = { status: 'business-rejected', code: 'IDEMPOTENCY_RECOVERY_REQUIRED', message: 'A previous claim expired before completion. Reconcile the operation outcome (transaction/outbox) before retrying; automatic re-execution is unsafe.' };
      this.audit(ir, operationRef, request, auth, result, ['IDEMPOTENCY_RECOVERY_REQUIRED']);
      return result;
    }

    let result: SubmissionResult;
    try {
      let data = await handler(built.payload, {
        auth, idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId, formId: ir.formId,
      });
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        data = filterReadableValues(ir, data as Record<string, unknown>, readPolicy.denied);
      }
      result = { status: 'succeeded', operationRef, data, idempotencyKey: request.idempotencyKey, durationMs: Date.now() - started };
    } catch (e) {
      const err = e as { code?: string; message?: string; issues?: ValidationIssue[] };
      if (err.issues) {
        result = { status: 'server-validation-failed', issues: err.issues.map((i) => ({ ...i, source: 'server' as const })) };
      } else if (err.code === 'PERMISSION_DENIED') {
        result = { status: 'permission-denied', code: err.code, message: err.message ?? 'Denied by operation.' };
      } else {
        result = { status: 'business-rejected', code: err.code ?? 'OPERATION_FAILED', message: err.message ?? 'Operation failed.' };
      }
    }
    if (result.status === 'succeeded') {
      await this.idempotency.complete(scopeKey, result);
    } else {
      await this.idempotency.release(scopeKey);
    }
    this.audit(ir, operationRef, request, auth, result, 'issues' in result ? result.issues.map((i) => i.code) : []);
    return result;
  }

  private audit(
    ir: FormIR, operationRef: string, request: TrustedSubmissionRequest,
    auth: AuthContext | undefined, result: SubmissionResult, issueCodes: string[],
  ): void {
    this.options.audit?.({
      timestamp: new Date().toISOString(), formId: ir.formId, formVersion: ir.formVersion,
      operationRef, correlationId: request.correlationId, idempotencyKey: request.idempotencyKey,
      userId: auth?.userId, tenantId: auth?.tenantId,
      outcome: result.status, issueCodes,
      valuePaths: Object.keys(request.values),
    });
  }
}

export interface NodeExecutorOptions {
  /** Server-derived principal captured by the trusted host (e.g. session user). */
  auth?: AuthContext;
  /** Preferred: resolve the verified principal at execution time. */
  resolveAuth?: () => AuthContext | undefined;
}

/**
 * Wrap the trusted handler as a SubmissionExecutor for a scheme (e.g. `api`,
 * `database`). Registered by the host project — never auto-created.
 *
 * IDENTITY BOUNDARY: the executor NEVER reads `context.authenticatedContext`.
 * The headless runtime's UI auth is not a backend principal. The trusted host
 * supplies identity via `resolveAuth`/`auth` when constructing the executor, or
 * calls `handler.handle(request, serverAuth)` directly.
 */
export function createNodeExecutor(handler: TrustedSubmissionHandler, scheme: string, options: NodeExecutorOptions = {}): SubmissionExecutor {
  return {
    scheme,
    contract: { supportsOfflineQueue: false, idempotent: true, trusted: true },
    supports(action: SubmissionAction): boolean { return handler.supportsOperation(action.operationRef); },
    async execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult> {
      const principal = options.resolveAuth ? options.resolveAuth() : options.auth;
      return handler.handle({
        formId: context.formId, formVersion: context.formVersion, values: context.values,
        operationRef: action.operationRef,
        idempotencyKey: context.idempotencyKey, correlationId: context.correlationId,
      }, principal);
    },
  };
}
