import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuthContext, SubmissionResult } from '@vds-form/types';
import type { TrustedSubmissionHandler, TrustedSubmissionRequest } from './index';

export interface NodeHttpOptions {
  handler: TrustedSubmissionHandler;
  /** Resolve identity using trusted host middleware/session/token validation. */
  resolveAuth?: (request: IncomingMessage) => AuthContext | undefined | Promise<AuthContext | undefined>;
  maxBodyBytes?: number;
  /** Optional structured logger. Never pass request body or form values. */
  log?: (entry: { correlationId: string; statusCode: number; outcome: string }) => void;
  path?: string;
}

const statusFor = (result: SubmissionResult): number => {
  switch (result.status) {
    case 'succeeded': return 200;
    case 'server-validation-failed': return 422;
    case 'permission-denied': return 403;
    case 'business-rejected': return result.code?.startsWith('IDEMPOTENCY') ? 409 : 422;
    case 'config-error': return 404;
    default: return 500;
  }
};

function respond(res: ServerResponse, status: number, correlationId: string, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-correlation-id': correlationId,
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > limit) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Malformed JSON request.'), { status: 400 }); }
}

export function createNodeHttpHandler(options: NodeHttpOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBytes = options.maxBodyBytes ?? 1024 * 1024;
  const path = options.path ?? '/forms/submit';
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBodyBytes must be a positive safe integer.');

  return (req, res) => {
    const supplied = req.headers['x-correlation-id'];
    const correlationId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    const finish = (status: number, outcome: string, body: unknown): void => {
      options.log?.({ correlationId, statusCode: status, outcome });
      respond(res, status, correlationId, body);
    };
    void (async () => {
      if (req.url?.split('?', 1)[0] !== path) return finish(404, 'not-found', { code: 'NOT_FOUND', message: 'Route not found.', correlationId });
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return finish(405, 'method-not-allowed', { code: 'METHOD_NOT_ALLOWED', message: 'POST is required.', correlationId });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        return finish(415, 'unsupported-media-type', { code: 'CONTENT_TYPE_UNSUPPORTED', message: 'Content-Type must be application/json.', correlationId });
      }
      try {
        const body = await readJson(req, maxBytes);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request JSON must be an object.'), { status: 400 });
        const data = body as Record<string, unknown>;
        if (Object.hasOwn(data, 'auth') || Object.hasOwn(data, 'authenticatedContext')) {
          return finish(400, 'body-auth-rejected', { code: 'AUTH_IN_BODY_FORBIDDEN', message: 'Authentication context must come from trusted server middleware.', correlationId });
        }
        if (typeof data.formId !== 'string' || !data.formId || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)
          || typeof data.idempotencyKey !== 'string' || !data.idempotencyKey
          || (data.operationRef !== undefined && typeof data.operationRef !== 'string')
          || (data.formVersion !== undefined && typeof data.formVersion !== 'string')) {
          return finish(400, 'invalid-request', { code: 'REQUEST_INVALID', message: 'Submission fields are malformed.', correlationId });
        }
        const request: TrustedSubmissionRequest = {
          formId: data.formId,
          values: data.values as Record<string, unknown>,
          idempotencyKey: data.idempotencyKey,
          correlationId,
          ...(data.formVersion ? { formVersion: data.formVersion as string } : {}),
          ...(data.operationRef ? { operationRef: data.operationRef as string } : {}),
        };
        const auth = await options.resolveAuth?.(req);
        const result = await options.handler.handle(request, auth);
        return finish(statusFor(result), result.status, result);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const code = status === 413 ? 'REQUEST_TOO_LARGE' : status === 400 ? 'JSON_INVALID' : 'REQUEST_FAILED';
        const http = status === 413 ? 413 : status === 400 ? 400 : 500;
        return finish(http, code, { code, message: status === 413 ? 'Request body exceeds the configured limit.' : status === 400 ? 'Request body is invalid.' : 'Submission could not be processed.', correlationId });
      }
    })();
  };
}

export function createNodeHttpServer(options: NodeHttpOptions): Server {
  return createServer(createNodeHttpHandler(options));
}
