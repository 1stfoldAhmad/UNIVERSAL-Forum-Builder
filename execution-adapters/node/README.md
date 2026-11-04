# VDS Form Builder — Node trusted execution adapter

A framework-independent, **trusted server-side** execution adapter. It
re-validates and re-authorizes **every** submission; client-side hiding is never
authorization. Operations resolve only against a registered `OperationRegistry`
(VDS Database/API Builder contracts) — there is no generic endpoint and no fake
`submit()`.

It shares the **same deterministic FormIR**, the **same canonical JSON
standard**, and the **same cross-language conformance fixtures** as the Django
and Laravel adapters.

## Security boundary (read this first)

This adapter enforces three hard guarantees (audit P0/P1):

1. **Identity is server-derived, never client-supplied.** `handle(request, auth)`
   takes the principal as a **separate, trusted second argument**. The request
   payload has no `auth` field. An HTTP layer must derive `auth` from the
   framework's authenticated session or validated token claims — **never** from
   the request body.
2. **The operation is bound to the compiled form.** The executed operation comes
   from `ir.submission.operationRef`. A client `operationRef` that differs is
   rejected (`OPERATION_OVERRIDE_FORBIDDEN`). An optional server-side
   `allowedOperations` allowlist further restricts it (`OPERATION_NOT_ALLOWED`).
3. **Idempotency is safe by construction.** Checked only *after* authentication,
   authorization and version checks; keys are scoped by
   `tenant + user + form + operation`; every claim carries a canonical SHA-256
   payload fingerprint (same key + different payload → `IDEMPOTENCY_KEY_CONFLICT`);
   claims are atomic (concurrent duplicates → `IDEMPOTENCY_IN_PROGRESS`).

### Check order

```
form lookup → operation binding → version → reverse inputMapping + re-validation
→ submitPermissions (fail-closed RBAC) → field-level write access
→ operation resolution → idempotency claim → execute → complete/release
```

## Wiring

```ts
import { TrustedSubmissionHandler, OperationRegistry, createNodeExecutor } from '@vds-form/execution-node';
import { SimpleRbacEvaluator } from '@vds-form/vds-contracts';

const operations = new OperationRegistry();
operations.register('database:contact.create', async (payload, ctx) => {
  // ctx.auth is the trusted principal; ctx.idempotencyKey / correlationId are set.
  return repo.contacts.create(payload);
});

const handler = new TrustedSubmissionHandler({
  forms: { contact: compiledIr },          // FormIR (or a FormDocument to compile)
  operations,
  rbac: new SimpleRbacEvaluator(),          // host policy engine in production
  // idempotencyStore: new SqliteIdempotencyStore('./idem.sqlite'), // durable
  // allowedOperations: ['database:contact.create'],               // optional
});

// As a SubmissionExecutor for the headless runtime (scheme e.g. 'database'):
const executor = createNodeExecutor(handler, 'database');
// The runtime passes context.authenticatedContext as the trusted auth argument.
// The HOST must populate that only from verified server state.

// Or call directly from your own HTTP layer:
const result = await handler.handle(
  { formId: 'contact', values, idempotencyKey, correlationId },
  authFromVerifiedSession(req),            // ← trusted principal, NOT req.body
);
```

### HTTP integration rule

When you expose this over HTTP, derive `auth` exclusively from your verified
server-side session / token middleware. Do **not** forward any client-supplied
`auth`, and do **not** forward a client `operationRef` (the handler rejects
overrides, but the cleanest boundary is to never pass one). See the Django and
Laravel adapters for reference HTTP layers that reject body-supplied auth with
`400 AUTH_IN_BODY_FORBIDDEN`.

## Idempotency storage

`IdempotencyStore` is a contract: `claim(key, fingerprint)`, `complete(key,
result)`, `release(key)`. Only successes are durable; failures release the claim
so retries can run.

| Store | Durability | Use |
| --- | --- | --- |
| `InMemoryIdempotencyStore` (default) | **Not** durable across restarts; single process | dev / tests |
| `SqliteIdempotencyStore(path)` | Durable; atomic via UNIQUE primary key (WAL) | reference; Node ≥ 22.5 (`node:sqlite`) |
| host Postgres/MySQL/Redis impl | Durable, distributed | **production** — implement the contract |

The scoped key and payload fingerprint are byte-identical across the Node,
Python, and PHP adapters (verified against
`packages/form-conformance/fixtures/idempotency.json`), so a shared durable store
behaves consistently no matter which backend wrote the record.

## Result codes

| Code | Status | HTTP |
| --- | --- | --- |
| `AUTH_IN_BODY_FORBIDDEN` | config-error | 400 |
| `AUTH_REQUIRED` / `AUTH_CONTEXT_INVALID` | permission-denied | 401 |
| `OPERATION_OVERRIDE_FORBIDDEN` / `OPERATION_NOT_ALLOWED` | permission-denied | 403 |
| `PERMISSION_DENIED` / `RBAC_NOT_CONFIGURED` / `FIELD_WRITE_DENIED` | permission-denied | 403 |
| `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_IN_PROGRESS` | business-rejected | 409 |
| `SUBMISSION_OPERATION_UNRESOLVED` | config-error | 500 |

## Run the tests

```bash
npx vitest run --project core execution-adapters/node
```

- `tests/trusted.test.ts` — handler guarantees + runtime→adapter end-to-end.
- `tests/security.test.ts` — adversarial: operation override/allowlist,
  cross-principal & cross-tenant isolation, payload-swap conflict, concurrent
  double-execution, durable restart replay, authorization-before-replay, forged
  body auth ignored.
- `tests/idempotency-parity.test.ts` — cross-language canonical/fingerprint/key
  vectors.

## Breaking changes (0.2.0)

- `handle(request, auth?)` — `auth` moved out of the request into a trusted
  second argument. `TrustedSubmissionRequest` no longer has an `auth` field.
- The executed operation is bound to the FormIR; a mismatching client
  `operationRef` is now rejected instead of honored.
- Idempotency is scoped + fingerprinted + atomic and runs after authz. The old
  `formId|idempotencyKey` in-memory cache (checked before auth) is gone.
