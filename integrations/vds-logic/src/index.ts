/**
 * @vds-form/vds-logic — REAL integration with the VDS JSON Logic Flow Builder
 * (`vds-json-logic`, github.com/1stfoldAhmad/NATIVE-JSON-FLOW-LOGIC-Builder).
 *
 * Submission operations `logic:<functionId>` execute through LogicEngine.callFunction;
 * `workflow:<flowId>` through LogicEngine.executeFlow. Results map 1:1 from the
 * engine's ExecutionResult contract. No invented APIs: the engine is built from
 * the actual source (scripts/fetch-vds-deps.sh) and used unmodified.
 */
import { LogicEngine } from 'vds-json-logic';
import type {
  AuthContext, ExecutorContract, SubmissionAction, SubmissionContext,
  SubmissionExecutor, SubmissionResult,
} from '@vds-form/types';

export { LogicEngine };

interface EngineExecutionResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  executionId: string;
  duration: number;
}

export function operationId(operationRef: string): string {
  const idx = operationRef.indexOf(':');
  return idx === -1 ? operationRef : operationRef.slice(idx + 1);
}

function authToUser(auth?: AuthContext): Record<string, unknown> | undefined {
  if (!auth) return undefined;
  return { id: auth.userId, tenantId: auth.tenantId, roles: auth.roles, permissions: auth.permissions, sessionId: auth.sessionId };
}

/** Map the engine's real error codes onto normalized submission results. */
export function mapExecutionResult(
  result: EngineExecutionResult, operationRef: string, idempotencyKey: string, contract: ExecutorContract,
): SubmissionResult {
  if (result.success) {
    return {
      status: 'succeeded', operationRef, data: result.data,
      executionId: result.executionId, idempotencyKey, durationMs: result.duration,
    };
  }
  const error = result.error ?? { code: 'EXEC_ERROR', message: 'Unknown engine error.' };
  const details = (error.details ?? {}) as { field?: string };
  switch (error.code) {
    case 'VALIDATION_FAILED':
    case 'PARAM_INVALID':
      return {
        status: 'server-validation-failed',
        issues: [{ code: error.code, message: error.message, path: details.field ?? '', severity: 'error', source: 'server' }],
      };
    case 'NOT_ALLOWED':
      return { status: 'permission-denied', code: error.code, message: error.message };
    case 'EXEC_CANCELLED':
      return { status: 'cancelled', idempotencyKey };
    case 'EXEC_TIMEOUT':
      return { status: 'network-failure', code: error.code, message: error.message, retryable: contract.idempotent };
    case 'REF_NOT_FOUND':
      return { status: 'config-error', code: 'SUBMISSION_OPERATION_UNRESOLVED', message: error.message };
    default:
      return { status: 'business-rejected', code: error.code, message: error.message, details: error.details };
  }
}

export class VdsLogicExecutor implements SubmissionExecutor {
  readonly scheme = 'logic';
  readonly contract: ExecutorContract = { supportsOfflineQueue: false, idempotent: false, trusted: true };
  constructor(private engine: LogicEngine) {}
  supports(action: SubmissionAction): boolean {
    try { this.engine.getFunctionDef(operationId(action.operationRef)); return true; } catch { return false; }
  }
  async execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult> {
    const result = await this.engine.callFunction(operationId(action.operationRef), context.values, {
      signal: context.signal, user: authToUser(context.authenticatedContext),
    }) as EngineExecutionResult;
    return mapExecutionResult(result, action.operationRef, context.idempotencyKey, this.contract);
  }
}

export class VdsWorkflowExecutor implements SubmissionExecutor {
  readonly scheme = 'workflow';
  readonly contract: ExecutorContract = { supportsOfflineQueue: false, idempotent: false, trusted: true };
  constructor(private engine: LogicEngine, private timeoutMs = 30000) {}
  supports(action: SubmissionAction): boolean {
    try { this.engine.getFlowDef(operationId(action.operationRef)); return true; } catch { return false; }
  }
  async execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult> {
    const result = await this.engine.executeFlow(operationId(action.operationRef), {
      input: context.values, signal: context.signal,
      user: authToUser(context.authenticatedContext), timeoutMs: this.timeoutMs,
    }) as EngineExecutionResult;
    return mapExecutionResult(result, action.operationRef, context.idempotencyKey, this.contract);
  }
}

export function createVdsExecutors(engine: LogicEngine): { logic: VdsLogicExecutor; workflow: VdsWorkflowExecutor } {
  return { logic: new VdsLogicExecutor(engine), workflow: new VdsWorkflowExecutor(engine) };
}
