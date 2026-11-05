/**
 * Standard Node HTTP integration layer for the trusted submission handler.
 *
 * Built ONLY on Node's built-in APIs (`node:http`, `node:crypto`). Express and
 * Fastify are deliberately NOT dependencies: `handleSubmissionRequest` is a
 * framework-neutral core that any host (including those frameworks) can adapt,
 * and `createSubmissionListener` is a ready-made `node:http` listener.
 *
 * Security boundary (identical in spirit to the Django and Laravel adapters):
 *  - Identity is SERVER-DERIVED via the injected `resolveAuth`. It is never read
 *    from the request body, and a body that tries to supply it is rejected.
 *  - The operation comes from the compiled FormIR, never from the client.
 *  - Body size is capped before parsing; JSON is parsed defensively.
 *  - Errors map to stable statuses and never leak internals or submitted values.
 *  - Logs contain identifiers and issue CODES only — never values or tokens.
 *
 * The host supplies real operations through `OperationRegistry`. This module
 * ships no production database, auth or RBAC service.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthContext, SubmissionResult, ValidationIssue } from '@vds-form/types';
import type { TrustedSubmissionHandler } from './index';

/** Framework-neutral request shape. */
export interface HttpRequestLike {
  method: string;
  /** Path only, e.g. '/vds/submit'. Query strings are ignored for routing. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body bytes. The listener enforces the size cap before producing this. */
  body: Uint8Array;
}

export interface HttpResponseLike {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Resolves the SERVER principal from transport metadata (cookie, bearer token…). */
export type HttpAuthResolver = (req: HttpRequestLike) => Promise<AuthContext | null> | AuthContext | null;

/** Structured log record. Contains NO submitted values and NO credentials. */
export interface HttpLogEntry {
  correlationId: string;
  formId?: string;
  method: string;
  path: string;
  httpStatus: number;
  outcome: string;
  issueCodes: string[];
  durationMs: number;
}

export interface SubmissionHttpOptions {
  handler: TrustedSubmissionHandler;
  /**
   * REQUIRED. Derives the principal from the transport (session cookie, verified
   * bearer token, mTLS identity…). Returning null means "anonymous".
   */
  resolveAuth: HttpAuthResolver;
  /** Permit anonymous submissions for public forms. Default false (fail closed). */
  allowAnonymous?: boolean;
  /** Route this layer answers. Default '/vds/submit'. */
  path?: string;
  /** Hard body cap in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Header carrying the idempotency key. Default 'idempotency-key'. */
  idempotencyHeader?: string;
  logger?: (entry: HttpLogEntry) => void;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Keys that would let a client assert its own identity/authority. */
const FORBIDDEN_BODY_KEYS = ['auth', 'principal', 'authenticatedContext', 'roles', 'permissions'];

const err = (code: string, message: string): ValidationIssue =>
  ({ code, message, path: '', severity: 'error', source: 'server' });

function header(req: HttpRequestLike, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Maps a trusted SubmissionResult to an HTTP status (same contract as Django). */
export function httpStatusFor(result: SubmissionResult): number {
  switch (result.status) {
    case 'succeeded': return 200;
    case 'queued-offline': return 202;
    case 'validation-failed':
    case 'server-validation-failed': return 422;
    case 'permission-denied': return 403;
    case 'business-rejected': return 409;
    case 'cancelled': return 409;
    case 'network-failure': return 502;
    default: return 500;
  }
}

function json(status: number, body: unknown, correlationId: string, extra: Record<string, string> = {}): HttpResponseLike {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-correlation-id': correlationId, 'cache-control': 'no-store', ...extra },
    body,
  };
}

/**
 * Framework-neutral core. Never throws for client errors: every failure becomes
 * a structured response with a stable code.
 */
export async function handleSubmissionRequest(
  req: HttpRequestLike,
  options: SubmissionHttpOptions,
): Promise<HttpResponseLike> {
  const started = Date.now();
  const route = options.path ?? '/vds/submit';
  const idemHeader = (options.idempotencyHeader ?? 'idempotency-key').toLowerCase();
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const rawCorrelation = header(req, 'x-correlation-id');
  const correlationId = rawCorrelation && CORRELATION_RE.test(rawCorrelation) ? rawCorrelation : randomUUID();

  let formId: string | undefined;
  let outcome = 'rejected';
  let issueCodes: string[] = [];
  let response: HttpResponseLike;

  const fail = (status: number, code: string, message: string, extra?: Record<string, string>): HttpResponseLike => {
    outcome = code;
    issueCodes = [code];
    return json(status, { status: status === 403 ? 'permission-denied' : 'config-error', code, message, correlationId, issues: [err(code, message)] }, correlationId, extra);
  };

  try {
    if (req.path !== route) {
      response = fail(404, 'NOT_FOUND', 'Unknown endpoint.');
      return response;
    }
    if (req.method !== 'POST') {
      response = fail(405, 'METHOD_NOT_ALLOWED', 'Use POST.', { allow: 'POST' });
      return response;
    }

    const contentType = (header(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      response = fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
      return response;
    }
    if (req.body.byteLength > maxBody) {
      response = fail(413, 'BODY_TOO_LARGE', `Request body exceeds ${maxBody} bytes.`);
      return response;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body));
    } catch {
      response = fail(400, 'MALFORMED_JSON', 'Request body is not valid JSON.');
      return response;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      response = fail(400, 'MALFORMED_BODY', 'Request body must be a JSON object.');
      return response;
    }
    const body = parsed as Record<string, unknown>;

    // A client may never assert its own identity or authority.
    for (const key of FORBIDDEN_BODY_KEYS) {
      if (key in body) {
        response = fail(400, 'AUTH_IN_BODY_FORBIDDEN', 'Identity must not be supplied in the request body.');
        return response;
      }
    }
    const values = body.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      response = fail(400, 'MALFORMED_BODY', 'Field "values" must be a JSON object.');
      return response;
    }
    for (const key of FORBIDDEN_BODY_KEYS) {
      if (key in (values as Record<string, unknown>)) {
        response = fail(400, 'AUTH_IN_BODY_FORBIDDEN', 'Identity must not be supplied in submitted values.');
        return response;
      }
    }

    formId = typeof body.formId === 'string' ? body.formId : undefined;
    if (!formId) {
      response = fail(400, 'FORM_ID_REQUIRED', 'Field "formId" is required.');
      return response;
    }

    const idempotencyKey = header(req, idemHeader) ?? (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '');
    if (!idempotencyKey || idempotencyKey.length > 200) {
      response = fail(400, 'IDEMPOTENCY_KEY_REQUIRED', `A valid "${idemHeader}" header is required.`);
      return response;
    }

    // Identity comes ONLY from the injected resolver.
    const auth = await options.resolveAuth(req);
    if (!auth && !options.allowAnonymous) {
      response = fail(401, 'AUTH_REQUIRED', 'Authentication is required.');
      return response;
    }

    const result = await options.handler.handle({
      formId,
      formVersion: typeof body.formVersion === 'string' ? body.formVersion : undefined,
      values: values as Record<string, unknown>,
      operationRef: typeof body.operationRef === 'string' ? body.operationRef : undefined,
      idempotencyKey,
      correlationId,
    }, auth ?? undefined);

    outcome = result.status;
    issueCodes = 'issues' in result && Array.isArray(result.issues)
      ? result.issues.map((i) => i.code)
      : ('code' in result && result.code ? [result.code] : []);

    // Never leak internals: a config-error carries a generic message + trace id.
    const safe: SubmissionResult = result.status === 'config-error'
      ? { status: 'config-error', code: result.code, message: 'The submission could not be processed.' }
      : result;

    response = json(httpStatusFor(result), { ...safe, correlationId }, correlationId);
    return response;
  } catch {
    // Unexpected internal failure: no stack, no values, no internals.
    response = fail(500, 'INTERNAL_ERROR', 'The submission could not be processed.');
    return response;
  } finally {
    options.logger?.({
      correlationId, formId, method: req.method, path: req.path,
      httpStatus: response!.status, outcome, issueCodes, durationMs: Date.now() - started,
    });
  }
}

/**
 * `node:http` listener. Enforces the body cap while streaming so an oversized
 * upload is rejected without buffering it fully.
 */
export function createSubmissionListener(options: SubmissionHttpOptions) {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    await new Promise<void>((resolve) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBody) {
          aborted = true;
          resolve();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve());
      req.on('error', () => { aborted = true; resolve(); });
    });

    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    const request: HttpRequestLike = {
      method: req.method ?? 'GET',
      path: (req.url ?? '/').split('?')[0],
      headers,
      body: aborted && size > maxBody ? new Uint8Array(maxBody + 1) : new Uint8Array(Buffer.concat(chunks)),
    };

    const out = await handleSubmissionRequest(request, options);
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.body));
  };
}
