/**
 * @vds-form/execution-node — trusted server-side execution adapter.
 * Framework-independent (no Express/Fastify assumptions). Re-validates and
 * re-authorizes EVERY submission; client-side hiding is never authorization.
 * Operations come from a registered OperationRegistry (Database/API Builder
 * contracts); there is no generic endpoint.
 */
import type {
  AuthContext, FormDocument, FormIR, RbacEvaluator, SubmissionAction,
  SubmissionContext, SubmissionExecutor, SubmissionResult, ValidationIssue,
} from '@vds-form/types';
import { compileForm } from '@vds-form/compiler';
import { computeEffectiveState, validateValues } from '@vds-form/validation';
import { getPath, setIn } from '@vds-form/expressions';

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
  /** Mapped payload exactly as the client executor sent it. */
  values: Record<string, unknown>;
  operationRef?: string;
  auth?: AuthContext;
  idempotencyKey: string;
  correlationId: string;
}

export interface TrustedHandlerOptions {
  forms: Record<string, FormIR | FormDocument>;
  operations: OperationRegistry;
  rbac?: RbacEvaluator;
  audit?: AuditSink;
  /** Pluggable idempotency store (default in-memory). */
  idempotencyStore?: Map<string, SubmissionResult>;
}

const serverIssue = (code: string, message: string, path = ''): ValidationIssue =>
  ({ code, message, path, severity: 'error', source: 'server' });

export class TrustedSubmissionHandler {
  private irs = new Map<string, FormIR>();
  private idempotency: Map<string, SubmissionResult>;

  constructor(private options: TrustedHandlerOptions) {
    this.idempotency = options.idempotencyStore ?? new Map();
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

  async handle(request: TrustedSubmissionRequest): Promise<SubmissionResult> {
    const started = Date.now();
    const ir = this.irs.get(request.formId);
    if (!ir) {
      return { status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED', message: `Form "${request.formId}" is not registered on this server.` };
    }
    const operationRef = request.operationRef ?? ir.submission?.operationRef ?? '';
    const audit = (result: SubmissionResult, issueCodes: string[] = []) => {
      this.options.audit?.({
        timestamp: new Date().toISOString(), formId: ir.formId, formVersion: ir.formVersion,
        operationRef, correlationId: request.correlationId, idempotencyKey: request.idempotencyKey,
        userId: request.auth?.userId, tenantId: request.auth?.tenantId,
        outcome: result.status, issueCodes,
        valuePaths: Object.keys(request.values),
      });
    };

    // Idempotent replay: return the recorded result without re-execution.
    const cached = this.idempotency.get(`${request.formId}|${request.idempotencyKey}`);
    if (cached) { audit(cached, ['IDEMPOTENT_REPLAY']); return cached; }

    if (request.formVersion && request.formVersion !== ir.formVersion) {
      const result: SubmissionResult = {
        status: 'server-validation-failed',
        issues: [serverIssue('FORM_VERSION_MISMATCH', `Client form version ${request.formVersion} ≠ server ${ir.formVersion}.`)],
      };
      audit(result, ['FORM_VERSION_MISMATCH']);
      return result;
    }

    // Reconstruct field-keyed values from the mapped payload (reverse inputMapping).
    let values: Record<string, unknown> = {};
    const mapping = ir.submission?.inputMapping;
    if (mapping && Object.keys(mapping).length) {
      for (const [param, sourcePath] of Object.entries(mapping)) {
        if (Object.hasOwn(request.values, param)) values = setIn(values, sourcePath, request.values[param]);
      }
    } else {
      values = request.values;
    }

    // Server-side effective state + full re-validation (never trusts the client).
    const { state } = computeEffectiveState(ir, values);
    const validation = validateValues(ir, values, state, { phase: 'submit' });
    if (!validation.valid) {
      const result: SubmissionResult = {
        status: 'server-validation-failed',
        issues: validation.issues.map((i) => ({ ...i, source: 'server' as const })),
      };
      audit(result, validation.issues.map((i) => i.code));
      return result;
    }

    // Authorization: fail closed when permissions are declared but no evaluator exists.
    const required = ir.security.submitPermissions ?? [];
    if (required.length) {
      if (!this.options.rbac) {
        const result: SubmissionResult = { status: 'permission-denied', code: 'RBAC_NOT_CONFIGURED', message: 'Form declares submitPermissions but no RBAC evaluator is registered on the server.', requiredPermissions: required };
        audit(result, ['RBAC_NOT_CONFIGURED']);
        return result;
      }
      const decision = this.options.rbac.evaluate(request.auth, required);
      if (!decision.allowed) {
        const result: SubmissionResult = { status: 'permission-denied', code: 'PERMISSION_DENIED', message: `Missing permissions: ${decision.missing.join(', ')}`, requiredPermissions: decision.missing };
        audit(result, ['PERMISSION_DENIED']);
        return result;
      }
    }
    // Field-level write protection.
    for (const [fieldId, access] of Object.entries(ir.security.fieldAccess ?? {})) {
      if (!access.write?.length) continue;
      const field = ir.fields.find((f) => f.id === fieldId);
      if (!field) continue;
      const provided = getPath(values, field.key);
      if (provided === undefined || provided === null) continue;
      const decision = this.options.rbac?.evaluate(request.auth, access.write) ?? { allowed: false, missing: access.write };
      if (!decision.allowed) {
        const result: SubmissionResult = { status: 'permission-denied', code: 'FIELD_WRITE_DENIED', message: `Not permitted to write field "${field.key}".`, requiredPermissions: decision.missing };
        audit(result, ['FIELD_WRITE_DENIED']);
        return result;
      }
    }

    const handler = this.options.operations.resolve(operationRef);
    if (!handler) {
      const result: SubmissionResult = { status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED', message: `Operation "${operationRef}" is not registered on this server.` };
      audit(result, ['SUBMISSION_OPERATION_UNRESOLVED']);
      return result;
    }

    let result: SubmissionResult;
    try {
      const data = await handler(request.values, {
        auth: request.auth, idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId, formId: ir.formId,
      });
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
      this.idempotency.set(`${request.formId}|${request.idempotencyKey}`, result);
    }
    audit(result, 'issues' in result ? result.issues.map((i) => i.code) : []);
    return result;
  }
}

/**
 * Wrap the trusted handler as a SubmissionExecutor for a scheme (e.g. `api`,
 * `database`). Registered by the host project — never auto-created.
 */
export function createNodeExecutor(handler: TrustedSubmissionHandler, scheme: string): SubmissionExecutor {
  return {
    scheme,
    contract: { supportsOfflineQueue: false, idempotent: true, trusted: true },
    supports(action: SubmissionAction): boolean { return handler.supportsOperation(action.operationRef); },
    async execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult> {
      return handler.handle({
        formId: context.formId, formVersion: context.formVersion, values: context.values,
        operationRef: action.operationRef, auth: context.authenticatedContext,
        idempotencyKey: context.idempotencyKey, correlationId: context.correlationId,
      });
    },
  };
}
