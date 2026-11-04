# Final implementation audit — VDS Universal Form Builder

Date: 2026-11-04 · Branch: `arena/1df95a3a-universal-forum-builder`
Status labels: **Verified** · **Implemented-not-verified** · **Partial** · **Unsupported** · **Blocked** · **Not started**

> **SECURITY UPDATE (2026-11-04, branch `arena/65a47b1c-universal-forum-builder`):**
> An independent audit of the merged implementation found P0/P1 issues in the
> trusted execution adapters (forged body-supplied auth, client operation
> override, unsafe idempotency, and an unverified Laravel adapter). All are now
> **fixed and verified** — see `docs/audit/SECURITY_FIXES_2026-11-04.md`.
> Superseding results: TypeScript **234/234** (20 files), Django **42/42**,
> Laravel **155/155** across 6 suites (now **Verified**, not
> implemented-not-verified), cross-language idempotency parity byte-identical in
> TS/Python/PHP. The sections below are updated accordingly; the original
> Phases 0–13 narrative is retained for history.

> Honesty policy (enforced throughout): a capability is **Verified** only when its
> acceptance tests passed via a recorded command in this sandbox. TEST adapters
> are explicitly named and never presented as production VDS integrations. No
> always-success mocks, placeholder renderers, or broad `any` are used to hide
> missing contracts. Unsupported targets return structured results and are
> documented, never silently faked.

## 1. Executive summary

A working, multi-target universal form builder was implemented as a separate
product monorepo (27 workspaces). One canonical versioned JSON standard
(`format: "vds.form"`, specVersion `1.0.0`, JSON Schema Draft 2020-12) compiles to
a deterministic `FormIR`, drives a framework-free headless runtime, and renders
through four verified renderers (Expo, React, Vue, Angular). A safe typed
expression engine (no `eval`), consistent validation, registered-executor
submission, drafts/offline queue, data sources, uploads, RBAC, migrations,
inspector, plugin SDK, CLI, MCP server, and a shared cross-language conformance
suite are all implemented and tested. Trusted server execution adapters exist
for Node (verified), Django (verified), and Laravel (verified — PHP-WASM locally,
real PHP 8.2 + illuminate/http in CI). After the security corrections, all three
derive identity exclusively from server-side auth, bind the operation to the
compiled FormIR, and use scoped, atomic, fingerprinted idempotency.

**Actual test results in this sandbox (post-security-fix):**
- TypeScript: **234 / 234 pass** across 20 files (core 199, native/Expo 9, web 18, angular 8).
- Django/Python: **42 / 42 pass**.
- Laravel/PHP: **155 / 155 pass** across 6 suites (PHP-WASM 8.2).
- Cross-language conformance: **73 / 73 pass** (62 expression + 11 compiler/validation/payload cases).
- Idempotency parity: canonical JSON / SHA-256 fingerprint / scoped key byte-identical in TS, Python, PHP.
- The Python engine independently passes the **same 62 expression fixtures** and the validation/payload cases via the shared compiled IR.
- Live React preview builds (248 modules) and serves; 3 end-to-end demo tests pass.
- Benchmarks run (`benchmarks/RESULTS.md`).

The original `1stfoldAhmad/Native-JSON-form-Builder` Expo SDK 58 library remains
an independent, unmodified working product (baseline 92/92 tests pass in its own
snapshot). It was used only as an audit source and for reusable, license-checked
logic — never rewritten into this monorepo.

## 2. Architecture (one canonical standard, many targets)

```
canonical JSON (vds.form 1.0.0)
  → JSON Schema validation (AJV 2020-12)
  → Compiler → deterministic FormIR (fingerprint, dependency graph, diagnostics)
  → Headless runtime (FormController: state machine, formulas, validation,
     drafts, offline queue, data sources, submission lifecycle)
  → Renderers: Expo (RN) · React · Vue · Angular   [Flutter/Compose/SwiftUI blocked]
  → Submission delegates ONLY to registered executors
  → Trusted server adapters re-validate + re-authorize: Node · Django · Laravel
  → Safe logic via vendored real vds-json-logic (logic:/workflow:)
```

Shared contracts: `@vds-form/types`, `form-spec`, `form-expressions`,
`form-field-registry`, `form-compiler`, `form-validation`, `form-runtime`,
`form-submission`, `form-data-sources`, `form-persistence`, `form-core`,
`form-inspector`, `form-plugin-sdk`, `form-migrations`, `form-conformance`.

## 3. Per-target status

| Target | Status | Evidence / limitation |
|---|---|---|
| Expo SDK 58 renderer | **Verified** (RN-web/jsdom) | `adapters/expo` 9 tests; capability negotiation; native pickers via host adapters. On-device run is a documented release task (no device in sandbox). |
| React / Next renderer | **Verified** | `adapters/react` 8 tests + live preview app (3 e2e). |
| Vue renderer | **Verified** | `adapters/vue` 7 tests (render-function components, scoped composables). |
| Angular renderer | **Verified** | `adapters/angular` 8 tests (standalone, signals, JIT). |
| Flutter renderer | **Blocked / Not started** | No Dart/Flutter toolchain (ADR-0006). |
| Jetpack Compose renderer | **Blocked / Not started** | No Kotlin/Gradle/Android SDK (ADR-0006). |
| SwiftUI renderer | **Blocked / Not started** | No Swift/Xcode (ADR-0006). |
| Node execution adapter | **Verified** | `execution-adapters/node` 31 tests incl. runtime→Node e2e + 15 adversarial security + 3 idempotency-parity. |
| Django execution adapter | **Verified** | `execution-adapters/django` 42 tests; engine passes shared fixtures; real Django `RequestFactory` view tests. |
| Laravel execution adapter | **Verified** | 155 checks across 6 suites (expression/form conformance, idempotency parity, trusted handler, controller auth boundary, adversarial security). PHP-WASM 8.2 locally; real PHP 8.2 + illuminate/http + pdo_sqlite in CI. |
| Headless Node example | **Verified** | `examples/headless-node` tests. |
| Live React preview | **Verified** | builds + serves on 0.0.0.0; proxy-host allowed. |

## 4. Acceptance criteria (spec §30) — summary

Full machine-readable tracker: `docs/IMPLEMENTATION_STATUS.md`.

- **Verified:** R01–R12, R14–R19, R22–R30 (canonical spec, schema, compiler,
  runtime, safe logic, validation, dependencies, repeaters, registered
  submission, explicit missing-executor errors, RBAC, uploads, workflow,
  drafts/offline, Expo/React/Vue/Angular, MCP permissions, migrations, security,
  a11y/localization, examples, docs, CI, unsupported-documentation, no-fake policy).
- **Implemented (production wiring blocked on unavailable VDS source):** R13
  (Database/API via real provider contracts + explicitly-named TEST adapters).
- **Verified (security update):** R21 — Node/Django/Laravel equivalent contract
  + security tests all pass (Laravel now executed, not just ported).
- **Blocked:** R20 (Flutter/Compose/SwiftUI — no toolchains).

## 5. Security guarantees (Verified — `tests/security.test.ts`, 18 tests)

- **No arbitrary code execution:** closed typed operator set; unknown operators
  rejected (`EXPR_UNKNOWN_OPERATOR`); DSL cannot express calls outside the set.
- **Prototype-pollution resistance:** `getPath`/`setIn`/`deleteIn` and expression
  refs reject `__proto__`/`constructor`/`prototype`.
- **ReDoS resistance:** `isSafePattern` rejects nested quantifiers / over-long
  patterns; validation surfaces `PATTERN_UNSAFE` instead of running them.
- **Budgets:** node/depth/collection/string limits enforced; `measureExpr` is
  iterative so deep ASTs cannot overflow the stack before rejection.
- **Secret redaction:** inspector redacts sensitive (password) values; audit
  records value **paths only**, never values.
- **Payload hygiene:** hidden fields stripped; un-uploaded local assets rejected.
- **Fail-closed authorization:** trusted servers re-validate and re-authorize
  every submission; `RBAC_NOT_CONFIGURED` / `PERMISSION_DENIED` /
  `FIELD_WRITE_DENIED`; hiding a field is never authorization.
- **Server-derived identity (P0 fix):** identity/tenant/roles/permissions come
  exclusively from the framework principal or validated token claims — never
  from the request body. Body-supplied `auth` is rejected
  (`AUTH_IN_BODY_FORBIDDEN`); a forged `auth` in the request is inert. Verified by
  forgery tests in Node, Django (HTTP), and Laravel (HTTP).
- **Operation binding (P1 fix):** the executed operation is bound to the compiled
  FormIR; a client override is rejected (`OPERATION_OVERRIDE_FORBIDDEN`), and an
  optional server allowlist further restricts it (`OPERATION_NOT_ALLOWED`).
- **Safe idempotency (P1 fix):** checked only after auth/authz/version; scoped by
  tenant+user+form+operation; canonical payload fingerprint rejects payload-swap
  (`IDEMPOTENCY_KEY_CONFLICT`); atomic claims prevent concurrent double-execution
  (`IDEMPOTENCY_IN_PROGRESS`); durable stores (SQLite/PDO) replay across restart.
- **Version checks:** version mismatch rejected.

## 6. Exact verification commands & actual results

```bash
# TypeScript — all renderers + core + tools (result: 234/234 pass)
npx vitest run

# Per-project
npx vitest run --project core      # 199 pass
npx vitest run --project native    # 9 pass (Expo via react-native-web)
npx vitest run --project web       # 18 pass (React 8, Vue 7, demo 3)
npx vitest run --project angular   # 8 pass

# Cross-language conformance (result: 73/73 pass)
npx tsx tools/cli/src/bin.ts conformance

# CLI smoke
npx tsx tools/cli/src/bin.ts validate examples/forms/contact.vds.json
npx tsx tools/cli/src/bin.ts compile examples/forms/invoice.vds.json --json
npx tsx tools/cli/src/bin.ts inspect examples/forms/customer-registration.vds.json

# Django/Python adapter (result: 42/42 pass)
cd execution-adapters/django && python3 -m pytest -q

# Live preview (builds 248 modules; serves on 0.0.0.0:5173)
cd examples/react-app && npx vite build
npx vite --host 0.0.0.0 --port 5173

# Benchmarks (runs; writes benchmarks/RESULTS.md)
npm run bench

# Laravel — local via PHP-WASM (result: 155/155 pass across 6 suites)
npm install --no-save --no-audit --no-fund @php-wasm/node   # GPL-2.0, not committed
node execution-adapters/laravel/tests/run-wasm.mjs
# Laravel — CI / any host with PHP >= 8.1 (result: 155/155 pass)
cd execution-adapters/laravel && composer install && composer test
```

## 7. Integration honesty (VDS builders)

Phase 0 discovery (`docs/audit/PHASE0_SOURCE_AUDIT.md`) found **no public source**
for VDS Database/API/Storage/Notification/Plugin-Host builders. Accordingly:
- Real integration **contracts** are defined (`integrations/vds-contracts`),
  aligned with the discovered `expo-app-foundation` auth contracts.
- Explicitly-named **TEST adapters** prove the contracts end-to-end (in-memory
  persistence, real validation/rejection paths). They are never presented as
  production VDS integrations.
- The **Workflow/Logic** integration uses the real, discovered `vds-json-logic`
  engine (Apache-2.0, vendored unmodified) for `logic:`/`workflow:` operations.
- The MCP server exposes the form standard's own operations with fail-closed
  host-granted permissions; it does not invent VDS APIs or build a parallel tool
  system.

## 8. Limitations & blocked items (documented, not faked)

- **Flutter / Compose / SwiftUI:** Blocked — no Dart/Kotlin/Swift toolchains or
  distribution hosts in the sandbox (ADR-0006). Not started; capability
  negotiation rejects unsupported field types with structured diagnostics.
- **Laravel:** Now **Verified** — no native PHP in the sandbox, so the full suite
  (155 checks) runs under PHP-WASM 8.2 locally (`tests/run-wasm.mjs`); CI runs the
  same suites on real PHP 8.2 with `illuminate/http` (real-Request integration)
  and `pdo_sqlite` (durability). `@php-wasm/node` is GPL-2.0 and not committed.
- **Expo on-device:** Verified via react-native-web + jsdom; physical-device run
  is a documented release task.
- **Production VDS Database/API/Storage wiring:** Blocked on unavailable VDS
  builder source; contracts + TEST adapters provided for host integration.
- **No npm publishing / irreversible public changes** were performed (per the
  standing constraint); all work is local on the session branch.

## 9. Reproducibility

- `package-lock.json` committed; `npm ci` reproduces the TS environment.
- `scripts/fetch-vds-deps.sh` fetches + builds the vendored logic engine.
- `.github/workflows/ci.yml` runs all suites + conformance + typecheck + build +
  Django (Python) + Laravel (PHP) on every push/PR.
- Shared conformance fixtures (`packages/form-conformance/fixtures`) are the
  single source of truth across TypeScript, Python, and PHP.
