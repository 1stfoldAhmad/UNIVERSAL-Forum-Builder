/**
 * Framework-agnostic Node HTTP handler for server-rendered forms.
 * GET renders the form; POST submits through the trusted Node execution
 * adapter (server-derived identity only) and re-renders errors or success.
 * Works with Fetch Request/Response, Node http, and Express-style middleware.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import type { AuthContext, FormDocument, FormIR, SubmissionResult, ValidationIssue } from '@vds-form/types';
import { TrustedSubmissionHandler, OperationRegistry, type AuditEntry } from '@vds-form/execution-node';
import type { RbacEvaluator } from '@vds-form/types';
import { computeEffectiveState } from '@vds-form/validation';
import { buildSubmissionPayload } from '@vds-form/submission';
import { renderForm, renderPage, type RenderOptions } from './html';
import { parseFormValues, parseUrlEncoded, type RawBody } from './parse';

export interface NodeFormHandlerOptions {
  forms: Record<string, FormDocument>;
  operations: OperationRegistry;
  rbac?: RbacEvaluator;
  audit?: (e: AuditEntry) => void;
  /** Server-derived identity. NEVER read from the request body. */
  resolveAuth?: (req: Request) => AuthContext | undefined | Promise<AuthContext | undefined>;
  render?: RenderOptions & { title?: string; clientScript?: string };
  /** Return JSON SubmissionResult instead of HTML (for API clients). */
  json?: boolean;
  basePath?: string;
}

export interface NodeFormHandler {
  handle(req: Request): Promise<Response>;
  node(req: IncomingMessage, res: ServerResponse): Promise<void>;
  middleware(): (req: IncomingMessage & { body?: unknown }, res: ServerResponse, next?: () => void) => Promise<void>;
  irFor(formId: string): FormIR | undefined;
}

export function createNodeFormHandler(opts: NodeFormHandlerOptions): NodeFormHandler {
  const trusted = new TrustedSubmissionHandler({ forms: opts.forms, operations: opts.operations, rbac: opts.rbac, audit: opts.audit });
  const irs = new Map<string, FormIR>();
  for (const [id, doc] of Object.entries(opts.forms)) {
    const r = compileForm(doc);
    if (r.ok) irs.set(id, r.ir);
  }
  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  async function renderIr(ir: FormIR, values: Record<string, unknown>, issues: ValidationIssue[], status = 200): Promise<Response> {
    const ctrl = new FormController({ ir, initialValues: values });
    await ctrl.initialize();
    if (issues.length) await ctrl.validate();
    const page = renderPage(ctrl, { ...opts.render, issues: issues.length ? issues : undefined, action: `${opts.basePath ?? ''}/${ir.formId}` });
    ctrl.dispose();
    return html(page, status);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const formId = url.pathname.split('/').filter(Boolean).pop() ?? '';
    const ir = irs.get(formId);
    if (!ir) return opts.json ? json({ error: 'FORM_NOT_FOUND', formId }, 404) : html(`<p>Form not found: ${formId}</p>`, 404);
    if (req.method === 'GET') return renderIr(ir, {}, []);
    if (req.method !== 'POST') return html('Method not allowed', 405);

    const ctype = req.headers.get('content-type') ?? '';
    let values: Record<string, unknown>;
    let idempotencyKey = url.searchParams.get('idempotencyKey') ?? '';
    if (ctype.includes('application/json')) {
      const body = await req.json() as { values?: Record<string, unknown>; idempotencyKey?: string };
      values = body.values ?? {};
      idempotencyKey = body.idempotencyKey ?? idempotencyKey;
    } else {
      const raw: RawBody = parseUrlEncoded(await req.text());
      values = parseFormValues(ir, raw, { csrfParam: opts.render?.csrfParam });
      idempotencyKey = (raw['_idempotencyKey'] as string) ?? idempotencyKey;
    }
    if (!idempotencyKey) idempotencyKey = `node-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const auth = await opts.resolveAuth?.(req);
    // Map field-keyed values to the operation payload the trusted adapter expects.
    const { state } = computeEffectiveState(ir, values);
    const built = ir.submission ? buildSubmissionPayload(ir, values, state, ir.submission) : { payload: values, issues: [] as ValidationIssue[] };
    const clientErrors = built.issues.filter((i) => i.severity === 'error');
    const result: SubmissionResult = clientErrors.length
      ? { status: 'server-validation-failed', issues: clientErrors }
      : await trusted.handle({ formId, values: built.payload, idempotencyKey, correlationId: req.headers.get('x-correlation-id') ?? '' }, auth);
    const wantsJson = opts.json || url.searchParams.get('format') === 'json' || (req.headers.get('accept') ?? '').includes('application/json');
    if (wantsJson) {
      const status = result.status === 'succeeded' ? 200 : result.status === 'server-validation-failed' ? 422 : result.status === 'permission-denied' ? 403 : result.status === 'business-rejected' ? 409 : 500;
      return json(result, status);
    }
    if (result.status === 'succeeded') {
      const ctrl = new FormController({ ir, initialValues: values });
      await ctrl.initialize();
      const page = renderPage(ctrl, { ...opts.render, action: `${opts.basePath ?? ''}/${ir.formId}` });
      ctrl.dispose();
      return html(page.replace('<form', '<p class="vds-success" role="status" data-vds-status>Submitted successfully.</p><form'));
    }
    const issues: ValidationIssue[] = result.status === 'server-validation-failed' ? result.issues : [];
    const status = result.status === 'permission-denied' ? 403 : result.status === 'server-validation-failed' ? 422 : 409;
    if (!issues.length) {
      return html(`<p class="vds-error" role="alert">${'message' in result ? result.message : result.status}</p>`, status);
    }
    return renderIr(ir, values, issues, status);
  }

  async function node(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://localhost${req.url ?? '/'}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body });
    const response = await handle(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  return {
    handle,
    node,
    middleware: () => async (req, res, next) => {
      if (req.body && typeof req.body === 'object') {
        // Express already parsed the body; wrap it as JSON.
        const headers = new Headers({ 'content-type': 'application/json' });
        const request = new Request(`http://localhost${req.url ?? '/'}`, { method: req.method, headers, body: JSON.stringify(req.body) });
        const response = await handle(request);
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      await node(req, res);
      next?.();
    },
    irFor: (id) => irs.get(id),
  };
}
