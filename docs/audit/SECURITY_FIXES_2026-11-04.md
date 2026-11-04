# Security corrections audit — trusted execution adapters

Date: 2026-11-04 · Branch: `arena/65a47b1c-universal-forum-builder`
Scope: P0/P1 findings from the independent audit of the merged implementation
(PR #1, `3539b65`). This report records the fixes and the **actual** verification
evidence. It is intentionally separate from `docs/FINAL_IMPLEMENTATION_AUDIT.md`
(the Phases 0–13 snapshot) so the security work can be reviewed on its own.

> Standing constraint honored: the repository and its architecture were **kept,
> not rewritten**. Only the security boundaries and their tests changed. No new
> field types or platform renderers were added.

## 1. Findings and disposition

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **P0** | Django view + Laravel controller read `auth` from the request body and only fell back to the framework principal. `SimpleRbacEvaluator` honors `*`, so a client could post `{"auth":{"userId":"attacker","permissions":["*"]}}` and self-grant. | **Fixed** in all three adapters. Identity is a server-derived trusted argument; body-supplied auth is rejected. |
| 2 | **P1** | Node handler used `request.operationRef ?? ir.submission.operationRef`, letting a client select/override the operation. | **Fixed** in all three. Operation is bound to the compiled FormIR; overrides rejected; optional server allowlist. |
| 3 | **P1** | Idempotency key was `formId\|idempotencyKey`, checked **before** auth/authz/version, in a non-atomic in-memory Map. Cross-principal replay, payload-swap, and double-execution were possible; restarts lost records. | **Fixed** in all three. Scoped + fingerprinted + atomic idempotency, checked after authz; durable reference stores. |
| 4 | **P1** | Laravel CI ran only the expression conformance; the trusted handler, field permissions, controller auth, and idempotency were never executed. | **Fixed.** Six PHP suites now run in CI on real PHP 8.2 (and locally under PHP-WASM). Laravel is **Verified**. |
| — | **P1** | Negative/adversarial security tests were missing for the execution adapters. | **Added** for Node, Django, and Laravel. |

Deferred (out of scope, per the audit): P2 real VDS Database/API/Storage/
Notification wiring, VDS Plugin Host/MCP production integration, Expo
real-device testing; P3 Flutter/Compose/SwiftUI renderers.

## 2. The security boundary (identical across Node / Django / Laravel)

### 2.1 Identity is server-derived (Finding 1)

- `handle(request, auth)` — the principal is a **separate, trusted second
  argument**. The request payload type no longer has an `auth` field.
- HTTP layers derive `auth` **only** from the framework's authenticated
  principal (`request.user` / `$request->user()`) or a host resolver that reads
  **validated** token claims. They never read the body.
- Any body that contains an `auth` key is rejected outright:
  `400 AUTH_IN_BODY_FORBIDDEN`. A forged `auth` smuggled into a direct
  `handle()` request is inert (only the trusted argument is read).
- Unauthenticated requests carry `auth = null`; the handler's fail-closed RBAC
  denies any permission-gated form. Public forms may accept anonymous
  (`allow_anonymous` / `allowAnonymous`, default true); hosts can require auth
  for every form (`401 AUTH_REQUIRED`).

### 2.2 Operation binding (Finding 2)

- The executed operation comes from `ir.submission.operationRef`.
- A client `operationRef` that differs → `403 OPERATION_OVERRIDE_FORBIDDEN`.
- Optional server-side `allowedOperations` / `allowed_operations` allowlist;
  a non-member → `403 OPERATION_NOT_ALLOWED`.
- HTTP layers do not forward a client `operationRef` at all; the handler guard
  protects direct callers (executors/tests) as defense in depth.

### 2.3 Safe idempotency (Finding 3)

Check order (idempotency is **after** auth/authz/version):

```
form lookup → operation binding → version → reverse inputMapping + re-validation
→ submitPermissions (fail-closed RBAC) → field write access → operation resolve
→ idempotency claim → execute → complete/release
```

- **Scoped key** = `sha256(canonicalJson([tenantId, userId, formId,
  operationRef, idempotencyKey]))`. No cross-principal or cross-tenant replay.
- **Payload fingerprint** = `sha256(canonicalJson(values))`. Same key + different
  payload → `409 IDEMPOTENCY_KEY_CONFLICT`.
- **Atomic claim**: first writer wins; concurrent duplicates see
  `409 IDEMPOTENCY_IN_PROGRESS` (or the completed replay). Only successes are
  durable; failures release the claim so retries can run.
- **Durable reference stores**: Node `SqliteIdempotencyStore` (`node:sqlite`,
  WAL, UNIQUE primary key), Python `SqliteIdempotencyStore` (stdlib `sqlite3`),
  PHP `PdoIdempotencyStore` (PDO SQLite/MySQL/Postgres, UNIQUE primary key).
  The in-memory stores remain the default for dev/tests and are explicitly
  documented as **not** durable. Production hosts implement the store contract
  against their database.

### 2.4 Cross-language parity

Canonical JSON (recursively sorted keys, compact, UTF-8), the SHA-256
fingerprint, and the scoped key are **byte-identical** across TypeScript,
Python, and PHP, verified against the shared
`packages/form-conformance/fixtures/idempotency.json`. A shared durable store
therefore behaves consistently regardless of which backend wrote the record.

Known PHP limitation (documented): `json_decode(..., true)` cannot distinguish
an empty object `{}` from an empty array `[]`; canonicalization treats an empty
PHP array as `[]`. Fingerprints only need per-backend consistency, and the shared
vectors avoid the ambiguous case.

## 3. Verification evidence (actual, this sandbox)

| Suite | Command | Result |
|---|---|---|
| TypeScript (all projects) | `npx vitest run` | **234 / 234** (20 files) |
| TypeScript typecheck | `npx tsc --noEmit` | **0 errors** |
| Node adapter | `npx vitest run --project core execution-adapters/node` | **31 / 31** (13 trusted + 15 security + 3 parity) |
| Django adapter | `cd execution-adapters/django && python3 -m pytest -q` | **42 / 42** |
| Laravel adapter (PHP-WASM 8.2) | `node execution-adapters/laravel/tests/run-wasm.mjs` | **155 / 155** (6 suites) |
| Cross-language conformance | `npx tsx tools/cli/src/bin.ts conformance` | **73 / 73** |

PHP suite breakdown: expression conformance 62, form conformance 7, idempotency
parity 7, trusted handler 25, controller auth boundary 20, adversarial security 34.

### 3.1 Adversarial tests added (per adapter)

Each adapter now proves, with a failing-before/passing-after test:

- **Forged auth** — a wildcard `auth` in the request body is rejected (HTTP) or
  inert (direct handler); the server principal with no permissions is denied.
  A dedicated test forges **all four identity fields** (`userId`, `tenantId`,
  `roles`, `permissions`) and asserts the operation receives the *server*
  principal verbatim — no forged field leaks (Node, Django, and PHP).
- **Operation override** — requesting a second *registered but unauthorized*
  operation is rejected and that operation never executes.
- **Operation allowlist** — a non-member operation is denied.
- **Cross-user / cross-tenant isolation** — the same key under a different
  principal/tenant executes independently (no replay of another's result).
- **Payload-swap conflict** — same key + different payload → conflict, no
  re-execution.
- **Concurrent double-execution** — two concurrent same-key requests execute the
  operation exactly once (Node async gate; Python thread; PHP atomic-claim at the
  storage layer, which is PHP's concurrency guarantee).
- **Authorization-before-replay** — revoking a permission after a successful
  submission denies the retry even with the same key (authz runs before cache).
- **Durable restart replay** — a completed result replays from SQLite/PDO after a
  simulated process restart, without re-execution.
- **Anonymous handling** — gated forms deny anonymous; `allow_anonymous=false`
  returns 401.

### 3.2 Laravel verification gap closed (Finding 4)

Previously CI ran only `php tests/run-conformance.php` (expressions). The CI job
now installs Composer dev deps (`illuminate/http`), enables `mbstring` +
`pdo_sqlite`, and runs **all six** suites via `composer test`. The controller
suite exercises a **real `Illuminate\Http\Request`** when available (it is, in
CI), proving the HTTP auth boundary end-to-end. Locally (no native PHP) the same
suites run under PHP-WASM 8.2 via `tests/run-wasm.mjs`; `@php-wasm/node` is
GPL-2.0 and intentionally **not** a committed dependency.

To make this verification **definitive rather than optional**, CI sets
`VDS_REQUIRE_ILLUMINATE=1` and `VDS_REQUIRE_PDO_SQLITE=1`: the controller and
security runners **fail** if the real-Request integration or the durable-restart
check would be skipped. Both gates were verified to fail when the dependency is
absent and pass when present, so CI cannot silently downgrade to the skip path.

## 4. Breaking changes

- **Node `@vds-form/execution-node` 0.1.0 → 0.2.0**: `handle(request, auth?)`;
  `auth` removed from `TrustedSubmissionRequest`; operation bound to FormIR;
  scoped/atomic idempotency after authz.
- **Django `vds-form-django` 1.0.0 → 1.1.0**: `handle(request, auth=None)`; view
  rejects body `auth` and derives identity from `request.user` / `auth_resolver`;
  operation binding; scoped/atomic idempotency.
- **Laravel**: `handle($request, $auth = null)`; controller `process()` core +
  injectable responder; body `auth` rejected; operation binding; scoped/atomic
  idempotency. (Library has no published version; composer.json updated.)

Hosts that previously passed `auth` inside the request must move it to the
trusted second argument and derive it from verified server state.

## 5. Review checklist (for the independent pre-merge audit)

- [x] No adapter reads identity/tenant/roles/permissions from the request body.
- [x] Body-supplied `auth` rejected at both HTTP layers (Django + Laravel).
- [x] Operation cannot be selected/overridden by the client; allowlist enforced.
- [x] Idempotency runs after auth/authz/version; scoped + fingerprinted + atomic.
- [x] Durable reference stores replay across restart; failures release claims.
- [x] Cross-language canonical/fingerprint/key parity proven by shared vectors.
- [x] Adversarial tests present and passing for all three adapters.
- [x] Laravel fully executed (not just ported); CI runs all suites on real PHP.
- [x] Architecture unchanged; no new field types or renderers.
- [ ] Independent reviewer sign-off before merge (this branch is **not** merged).
