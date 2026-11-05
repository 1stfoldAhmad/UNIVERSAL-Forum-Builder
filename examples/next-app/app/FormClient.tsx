'use client';

/**
 * The client boundary. Receives ONLY the compiled, JSON-serializable FormIR.
 * No compiler, trusted handler, operation registry or credential crosses into
 * this module. The controller is created once per mount so server and client
 * render the same initial tree (correct hydration).
 */
import { useMemo, useState } from 'react';
import { UniversalForm } from '@vds-form/react';
import { FormController } from '@vds-form/runtime';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import type { FormIR, SubmissionResult } from '@vds-form/types';
import { createTrustedHttpExecutor } from '../lib/httpExecutor';

export function FormClient({ ir }: { ir: FormIR }) {
  const [result, setResult] = useState<SubmissionResult | null>(null);

  const controller = useMemo(() => {
    const executors = new SubmissionExecutorRegistry();
    executors.register(createTrustedHttpExecutor({
      // Demo credential. A real host reads its own session/token here.
      authorization: () => 'Bearer demo-token',
    }));
    const ctrl = new FormController({ ir, executors });
    void ctrl.initialize();
    return ctrl;
  }, [ir]);

  return (
    <>
      <UniversalForm controller={controller} onSubmitted={setResult} />
      {result ? (
        <p data-testid="client-result" role="status" style={{ marginTop: 16, fontWeight: 600 }}>
          {result.status === 'succeeded' ? 'Submitted to the trusted server.' : `Submission status: ${result.status}`}
        </p>
      ) : null}
    </>
  );
}
