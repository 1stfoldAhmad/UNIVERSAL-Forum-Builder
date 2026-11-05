/**
 * SERVER COMPONENT. Compiles the canonical form on the server and passes only
 * the serialized FormIR to the client boundary.
 */
import { compileFormServer, serializeFormIR } from '../lib/forms';
import { FormClient } from './FormClient';
import type { FormIR } from '@vds-form/types';

export const dynamic = 'force-dynamic';

export default function Page() {
  const ir: FormIR = compileFormServer('contact');
  // Round-trip through JSON so the client receives exactly what the server
  // rendered with — no class instances, functions or undefined values.
  const clientIR = JSON.parse(serializeFormIR(ir)) as FormIR;

  return (
    <>
      <h1 style={{ fontSize: 24 }}>Next.js App Router example</h1>
      <p style={{ color: '#555' }}>
        The form definition is compiled to FormIR on the server. The browser receives only
        serialized IR and submits through a trusted route that derives identity server-side.
      </p>
      <section style={{ background: '#fff', borderRadius: 12, padding: 8 }}>
        <FormClient ir={clientIR} />
      </section>
    </>
  );
}
