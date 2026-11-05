import { randomUUID } from 'node:crypto';
import { OperationRegistry, TrustedSubmissionHandler } from '@vds-form/execution-node';
import type { FormDocument } from '@vds-form/types';
import contactDocument from '../../../../../forms/contact.vds.json';

// Demonstration-only registered TEST operation. A production host replaces this
// callback with its own authorized API/database operation; no fake DB adapter.
const acceptedContacts: Record<string, unknown>[] = [];
const operations = new OperationRegistry();
operations.register('test:contact.create', (payload) => {
  const receipt = { id: `test-${acceptedContacts.length + 1}`, accepted: true };
  acceptedContacts.push({ ...payload });
  return receipt;
});
const trusted = new TrustedSubmissionHandler({
  forms: { contact: contactDocument as unknown as FormDocument },
  operations,
});

const statusFor = (result: { status: string; code?: string }): number => {
  switch (result.status) {
    case 'succeeded': return 200;
    case 'server-validation-failed': return 422;
    case 'permission-denied': return 403;
    case 'business-rejected': return result.code?.startsWith('IDEMPOTENCY') ? 409 : 422;
    case 'config-error': return 404;
    default: return 500;
  }
};

export async function POST(request: Request) {
  const supplied = request.headers.get('x-correlation-id') ?? '';
  const correlationId = /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  const respond = (status: number, body: unknown) => Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-correlation-id': correlationId },
  });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return respond(415, { code: 'CONTENT_TYPE_UNSUPPORTED', message: 'Content-Type must be application/json.', correlationId });
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > 64 * 1024) return respond(413, { code: 'REQUEST_TOO_LARGE', correlationId });
  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 64 * 1024) return respond(413, { code: 'REQUEST_TOO_LARGE', correlationId });
    body = JSON.parse(text);
  } catch {
    return respond(400, { code: 'JSON_INVALID', message: 'Request body is invalid.', correlationId });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return respond(400, { code: 'REQUEST_INVALID', correlationId });
  }
  const input = body as Record<string, unknown>;
  if (Object.hasOwn(input, 'auth') || Object.hasOwn(input, 'authenticatedContext')) {
    return respond(400, { code: 'AUTH_IN_BODY_FORBIDDEN', message: 'Identity must come from trusted host middleware.', correlationId });
  }
  if (typeof input.formId !== 'string' || !input.formId || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey
    || (input.operationRef !== undefined && typeof input.operationRef !== 'string')) {
    return respond(400, { code: 'REQUEST_INVALID', correlationId });
  }
  // This demo form is public; production applications pass verified identity
  // from their host session/token resolver as the second handle() argument.
  const result = await trusted.handle({
    formId: input.formId,
    formVersion: typeof input.formVersion === 'string' ? input.formVersion : undefined,
    operationRef: typeof input.operationRef === 'string' ? input.operationRef : undefined,
    values: input.values as Record<string, unknown>,
    idempotencyKey: input.idempotencyKey,
    correlationId,
  });
  return respond(statusFor(result), result);
}
