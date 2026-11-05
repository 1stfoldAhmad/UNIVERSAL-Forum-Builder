# Integration boundaries

## Trusted execution identity
Node/Django/Laravel trusted handlers derive identity only from server-side auth arguments. Request-body `auth` is rejected (`AUTH_IN_BODY_FORBIDDEN`). Browser/UI auth is never authoritative backend identity.

## Operation binding
The operation is bound from compiled FormIR; request `operationRef` overrides are rejected unless explicitly allowlisted. Submission permissions and concrete-instance field write authorization are enforced server-side. Read policy fails closed and redacts replayed results.

## Idempotency recovery contract
- Scoped key: tenant + user + form + operation + client key.
- Payload fingerprint: canonical SHA-256; payload swap → conflict.
- Atomic claim; in-progress → 409; expired lease → `IDEMPOTENCY_RECOVERY_REQUIRED` (409).
- Host must reconcile abandoned claims via transaction/outbox:
  - committed → `complete(key, knownResult)` → future replays;
  - provably not committed → `release(key)` → retry allowed.
- The store never auto-re-executes an expired claim.

## VDS builder integrations
No public VDS Database/API/Storage/Notification/Plugin-Host builder source was available (Phase 0). This repo ships:
1. Provider contracts aligned to the canonical standard.
2. Explicitly named TEST adapters that prove the contracts.
Production VDS integration is **blocked**, not claimed. Hosts register real operations/providers; TEST adapters must not be presented as production.

## Packaging
Release tarballs are built/packed locally and in CI but **not published** without explicit authorization. `@vds-form/vds-logic` is excluded from packing because it depends on a vendored `file:` package. The root package engine floor is Node ≥ 22.5 because the trusted adapter's durable SQLite store depends on `node:sqlite`. The CI workflow now declares Node 22, 24 and 26 matrix jobs; only the current local runtime is evidenced by this checkout until those workflow jobs complete.
