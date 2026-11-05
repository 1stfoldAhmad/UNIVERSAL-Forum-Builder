'use client';

import { useEffect, useState } from 'react';
import { createForm, SubmissionExecutorRegistry, type FormController, type FormDocument, type SubmissionExecutor } from '@vds-form/core';
import { UniversalForm, REACT_CAPABILITY_MANIFEST } from '@vds-form/react';

export default function FormClient({ document }: { document: FormDocument }) {
  const [controller, setController] = useState<FormController | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let created: FormController | null = null;
    const executors = new SubmissionExecutorRegistry();
    const executor: SubmissionExecutor = {
      scheme: 'test',
      contract: { supportsOfflineQueue: false, idempotent: true, trusted: false },
      supports: (action) => action.operationRef === 'test:contact.create',
      async execute(action, context) {
        const response = await fetch('/api/forms/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            formId: context.formId,
            formVersion: context.formVersion,
            operationRef: action.operationRef,
            values: context.values,
            idempotencyKey: context.idempotencyKey,
            correlationId: context.correlationId,
          }),
        });
        return await response.json();
      },
    };
    executors.register(executor);
    const compiled = createForm({ document, target: REACT_CAPABILITY_MANIFEST, executors });
    if (!compiled.ok) {
      setError(compiled.diagnostics.map((item) => item.message).join('\n'));
      return () => { active = false; };
    }
    created = compiled.controller;
    void created.initialize().then(() => { if (active) setController(created); });
    return () => { active = false; created?.dispose(); };
  }, [document]);

  if (error) return <p role="alert">{error}</p>;
  if (!controller) return <p aria-live="polite">Loading form…</p>;
  return <section>
    <UniversalForm controller={controller} onSubmitted={(submission) => setResult(submission.status)} />
    <p aria-live="polite" data-testid="submission-status">{result}</p>
  </section>;
}
