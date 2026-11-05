/**
 * Trusted submission endpoint built on the standard Node HTTP boundary.
 *
 * Identity comes from the Authorization header via the injected resolver; the
 * body may never assert identity. The operation is bound by the compiled FormIR.
 */
import { handleSubmissionRequest } from '@vds-form/execution-node';
import { trustedHandler, resolveDemoPrincipal } from '../../../lib/trusted';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  const result = await handleSubmissionRequest(
    { method: 'POST', path: '/vds/submit', headers, body },
    {
      handler: trustedHandler(),
      resolveAuth: () => resolveDemoPrincipal(headers.authorization ?? null),
      path: '/vds/submit',
      logger: (entry) => console.info('[vds-http]', JSON.stringify(entry)),
    },
  );
  return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
}
