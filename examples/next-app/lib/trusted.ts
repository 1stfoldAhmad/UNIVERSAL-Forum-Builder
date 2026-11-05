/**
 * SERVER-ONLY trusted submission wiring.
 *
 * The operation registry holds REAL host operations. In this example they are
 * the explicitly named TEST adapters from @vds-form/vds-contracts — there is no
 * pretend production database. A host application registers its own operations
 * here and derives identity from its own session/token verification.
 */
import 'server-only';
import { OperationRegistry, TrustedSubmissionHandler } from '@vds-form/execution-node';
import { SimpleRbacEvaluator, InMemoryRecordStore } from '@vds-form/vds-contracts';
import type { AuthContext } from '@vds-form/types';
import { compileFormServer, FORM_IDS } from './forms';

let singleton: TrustedSubmissionHandler | undefined;

/** Process-wide handler so the in-memory idempotency store survives requests. */
export function trustedHandler(): TrustedSubmissionHandler {
  if (singleton) return singleton;
  const store = new InMemoryRecordStore();
  const operations = new OperationRegistry();
  // TEST operation, clearly named. Replace with a real host operation.
  operations.register('test:contact.create', (payload) => store.create('contact', payload));

  singleton = new TrustedSubmissionHandler({
    forms: Object.fromEntries(FORM_IDS.map((id) => [id, compileFormServer(id)])),
    operations,
    rbac: new SimpleRbacEvaluator(),
    // An audit sink that records codes and identifiers only — never values.
    audit: (entry) => {
      console.info('[vds-audit]', JSON.stringify({
        formId: entry.formId, operationRef: entry.operationRef,
        outcome: entry.outcome, issueCodes: entry.issueCodes,
      }));
    },
  });
  return singleton;
}

/**
 * Demo principal resolver. A REAL host must verify its own session cookie or
 * bearer token here. Identity is NEVER read from the request body.
 */
export function resolveDemoPrincipal(authorization: string | null): AuthContext | null {
  if (authorization !== 'Bearer demo-token') return null;
  return { userId: 'demo-user', tenantId: 'demo-tenant', roles: ['user'], permissions: ['contact:create'] };
}
