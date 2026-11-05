/**
 * CLIENT-SAFE submission executor that POSTs to the trusted Next.js route.
 *
 * It sends only the mapped payload plus the idempotency key. It NEVER sends
 * identity: the server derives the principal from the Authorization header.
 * The operation ref is echoed for server-side binding validation only — the
 * server takes the operation from the compiled FormIR, not from this value.
 */
import type {
  SubmissionAction, SubmissionContext, SubmissionExecutor, SubmissionResult,
} from '@vds-form/types';

export interface TrustedHttpExecutorOptions {
  endpoint?: string;
  /** Supplies the transport credential (host session/token). Never a body field. */
  authorization?: () => string | null;
}

export function createTrustedHttpExecutor(options: TrustedHttpExecutorOptions = {}): SubmissionExecutor {
  const endpoint = options.endpoint ?? '/api/submit';
  return {
    scheme: 'test',
    contract: { supportsOfflineQueue: false, idempotent: true, trusted: true },
    supports: () => true,
    async execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'idempotency-key': context.idempotencyKey,
        'x-correlation-id': context.correlationId,
      };
      const authz = options.authorization?.();
      if (authz) headers.authorization = authz;

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: context.signal,
          body: JSON.stringify({
            formId: context.formId,
            formVersion: context.formVersion,
            operationRef: action.operationRef,
            values: context.values,
          }),
        });
      } catch (e) {
        return { status: 'network-failure', code: 'NETWORK_ERROR', message: (e as Error).message, retryable: true };
      }

      const parsed = await response.json().catch(() => null) as SubmissionResult | null;
      if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
      return {
        status: 'network-failure', code: 'BAD_SERVER_RESPONSE',
        message: `Server returned ${response.status} without a submission result.`, retryable: false,
      };
    },
  };
}
