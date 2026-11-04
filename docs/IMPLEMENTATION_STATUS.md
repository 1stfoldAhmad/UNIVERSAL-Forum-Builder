# Implementation ledger — VDS Universal Form Builder

Status labels: `not-started` · `in-progress` · `implemented` · `verified` · `blocked` · `unsupported`.
A row is **verified** only when its acceptance criteria passed via the recorded command.
Final narrative audit: `docs/FINAL_IMPLEMENTATION_AUDIT.md`.

Last updated: 2026-11-04 (P0/P1 security corrections implemented + verified on `arena/65a47b1c-universal-forum-builder`; see `docs/audit/SECURITY_FIXES_2026-11-04.md`)

## Test totals (actual, this sandbox)

| Suite | Command | Result |
|---|---|---|
| TypeScript (all projects) | `npx vitest run` | **233 / 233 pass** (20 files) |
| — core | `npx vitest run --project core` | 198 pass |
| — native (Expo via RN-web) | `npx vitest run --project native` | 9 pass |
| — web (React/Vue/demo) | `npx vitest run --project web` | 18 pass |
| — angular (JIT) | `npx vitest run --project angular` | 8 pass |
| Django/Python adapter | `cd execution-adapters/django && python3 -m pytest -q` | **41 / 41 pass** |
| Laravel/PHP adapter (PHP-WASM 8.2) | `node execution-adapters/laravel/tests/run-wasm.mjs` | **153 / 153 pass** (6 suites) |
| Cross-language conformance | `npx tsx tools/cli/src/bin.ts conformance` | **73 / 73 pass** |
| Idempotency parity (TS/Python/PHP) | shared `fixtures/idempotency.json` | byte-identical in all 3 |
| Benchmarks | `npm run bench` | runs; `benchmarks/RESULTS.md` |

## Acceptance-criteria tracker (spec §30)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| R01 | Original Expo SDK 58 repo works independently | verified | Unmodified snapshot baseline `npm ci && npm test`: 92/92 (`docs/audit/PHASE0_SOURCE_AUDIT.md`) |
| R02 | Universal builder exists as separate product | verified | This monorepo; reference repo untouched (ADR-0001/0004) |
| R03 | One canonical versioned JSON spec published | verified | `format:"vds.form"`, specVersion 1.0.0; `packages/form-spec`; 9 canonical examples |
| R04 | JSON Schema validation works | verified | AJV Draft 2020-12; `packages/form-spec` 18 tests; `vds-form validate` |
| R05 | Compiler produces normalized FormIR | verified | `packages/form-compiler` 27 tests; deterministic fingerprint; `vds-form compile --json` |
| R06 | Headless runtime without UI framework | verified | `packages/form-runtime` 34 tests; `FormController` framework-free |
| R07 | Conditions/formulas execute safely | verified | `packages/form-expressions` 22 tests; typed AST, no eval; budgets; security suite |
| R08 | Validation consistent | verified | `form-validation`; shared conformance validation cases pass in TS **and** Python |
| R09 | Dynamic dependencies update correctly | verified | Kahn topo order, cycle detection; runtime recompute tests; invoice live totals |
| R10 | Nested forms and repeaters work | verified | Stable row identity (not indexes); nested groups; repeater tests across renderers |
| R11 | Submission delegates to registered real operations | verified | `form-submission` + Node/Django trusted handlers; runtime→Node e2e test |
| R12 | Missing executors → explicit errors | verified | `SUBMISSION_EXECUTOR_NOT_REGISTERED` / `SUBMISSION_OPERATION_UNRESOLVED`; tested |
| R13 | Database/API integrate via their own VDS contracts | implemented | No public VDS Database/API Builder source (Phase 0). Real provider contracts + explicitly-named TEST adapters (`integrations/vds-contracts`); host registers production operations. Production wiring **blocked** on unavailable VDS source |
| R14 | Auth/RBAC enforced by trusted execution | verified | Fail-closed RBAC in Node + Django + Laravel handlers; identity is a **server-derived trusted argument, never from the request body** (body `auth` → `AUTH_IN_BODY_FORBIDDEN`); `RBAC_NOT_CONFIGURED`/`PERMISSION_DENIED`/`FIELD_WRITE_DENIED`; adversarial forgery tests in all 3 adapters |
| R15 | Storage/uploads via registered providers | verified | `UploadProvider` contract; drag-drop in React/Vue/Angular/Expo; `TestUploadProvider`; asset guards |
| R16 | Workflow integration uses Workflow Builder | verified | Real `vds-json-logic` engine vendored; `logic:`/`workflow:` executors (`integrations/vds-logic`, 7 tests) |
| R17 | Draft persistence + approved offline queue | verified | `form-persistence`; version-checked drafts; offline queue gated by contract; runtime tests |
| R18 | Expo rendering verified | verified | `adapters/expo` 9 tests via RN-web/jsdom; capability negotiation. **On-device** verification not possible in sandbox (documented) |
| R19 | React/Angular/Vue renderers verified | verified | React 8, Vue 7, Angular 8 tests; live React preview app (3 e2e tests) |
| R20 | Flutter/Compose/SwiftUI at declared conformance | blocked | No Dart/Kotlin/Swift toolchains or distribution hosts (ADR-0006). Not started; documented unsupported-in-sandbox |
| R21 | Node/Django/Laravel equivalent contract tests | verified | Node 30 tests **verified**; Django 41 tests **verified**; Laravel 153 checks across 6 suites **verified** (PHP-WASM 8.2 locally; real PHP 8.2 + illuminate/http in CI). All three share the same expression/form/idempotency fixtures |
| R22 | AI/MCP/Plugin Host tools permission-controlled | verified | `tools/mcp-server` 10 tests; fail-closed host-granted permissions; 6 contract-backed tools. VDS Plugin-Host source unavailable → standalone MCP (no invented VDS APIs) |
| R23 | Migrations tested | verified | `form-migrations` 6 tests; BFS path, backup, allowLossy; `vds-form migrate` |
| R24 | Security tests pass | verified | Core `tests/security.test.ts` 18 tests (pollution, no-eval, ReDoS, budgets, redaction, payload hygiene, fail-closed RBAC) **plus** adversarial adapter suites: Node 14, Django 13, PHP 32 — forged auth, operation override/allowlist, cross-principal/tenant idempotency isolation, payload-swap conflict, concurrent double-execution, durable restart replay, authorization-before-replay |
| R25 | Accessibility/localization contracts implemented | verified | aria-* + label association (React/Angular tests); `localize` + locale fallback; capability manifests |
| R26 | Examples installable/runnable | verified | `examples/react-app` builds (`vite build`, 248 modules) + live server; headless-node example; 9 canonical forms |
| R27 | Documentation matches implementation | verified | This ledger + `FINAL_IMPLEMENTATION_AUDIT.md` + ADRs + per-package READMEs |
| R28 | CI reproducible evidence | verified | `.github/workflows/ci.yml` runs all suites + conformance + typecheck + build |
| R29 | Unsupported capabilities documented | verified | ADR-0006; capability negotiation rejects unsupported types; audit lists blocked targets |
| R30 | No fake-success/placeholder presented as complete | verified | TEST adapters explicitly named; status labels enforced; no always-success mocks presented as real |

## Package ledger

| Requirement | Package/path | Status | Tests | Verification command | Result |
|---|---|---|---|---|---|
| Canonical spec + schema | `packages/form-spec`, `specifications/json-schema` | verified | 18 | `vitest run --project core packages/form-spec` | pass |
| Expression engine | `packages/form-expressions` | verified | 22 | `vitest run --project core packages/form-expressions` | pass |
| Field registry | `packages/form-field-registry` | verified | (31 contracts) | compiler/conformance | pass |
| Compiler → FormIR | `packages/form-compiler` | verified | 27 | `vitest run --project core packages/form-compiler` | pass |
| Validation | `packages/form-validation` | verified | (via runtime/conformance) | conformance | pass |
| Headless runtime | `packages/form-runtime` | verified | 34 | `vitest run --project core packages/form-runtime` | pass |
| Submission contracts | `packages/form-submission` | verified | (via runtime/node) | node e2e | pass |
| Data sources | `packages/form-data-sources` | verified | (via runtime/demo) | demo e2e | pass |
| Persistence/offline | `packages/form-persistence` | verified | (via runtime) | runtime | pass |
| Core facade | `packages/form-core` | verified | — | typecheck | pass |
| Inspector | `packages/form-inspector` | verified | 4 | `vitest run --project core packages/form-inspector` | pass |
| Plugin SDK | `packages/form-plugin-sdk` | verified | 6 | `vitest run --project core packages/form-plugin-sdk` | pass |
| Migrations | `packages/form-migrations` | verified | 6 | `vitest run --project core packages/form-migrations` | pass |
| Conformance fixtures + runner | `packages/form-conformance` | verified | 5 (73 cases) | `vds-form conformance` | 73/73 |
| VDS logic/workflow integration | `integrations/vds-logic` | verified | 7 | `vitest run --project core integrations/vds-logic` | pass |
| VDS provider contracts + TEST adapters | `integrations/vds-contracts` | implemented | (via consumers) | node/react/django | pass |
| Node trusted execution | `execution-adapters/node` | verified | 30 | `vitest run --project core execution-adapters/node` | 30/30 |
| Django trusted execution | `execution-adapters/django` | verified | 41 | `python3 -m pytest -q` | 41/41 |
| Laravel trusted execution | `execution-adapters/laravel` | verified | 153 (6 suites) | `composer test` (CI) / `node tests/run-wasm.mjs` (local) | 153/153 |
| Expo renderer | `adapters/expo` | verified | 9 | `vitest run --project native` | pass |
| React renderer | `adapters/react` | verified | 8 | `vitest run --project web` | pass |
| Vue renderer | `adapters/vue` | verified | 7 | `vitest run --project web` | pass |
| Angular renderer | `adapters/angular` | verified | 8 | `vitest run --project angular` | pass |
| CLI | `tools/cli` | verified | 11 | `vitest run --project core tools/cli` | pass |
| MCP server | `tools/mcp-server` | verified | 10 | `vitest run --project core tools/mcp-server` | pass |
| Security suite | `tests/security.test.ts` | verified | 18 | `vitest run --project core tests/security` | pass |
| Live preview example | `examples/react-app` | verified | 3 | `vitest run --project web examples/react-app` | pass |
| Benchmarks | `benchmarks/run.ts` | verified | — | `npm run bench` | runs |
| Flutter renderer | — | blocked | — | — | no Dart toolchain |
| Compose renderer | — | blocked | — | — | no Kotlin toolchain |
| SwiftUI renderer | — | blocked | — | — | no Swift toolchain |

## Environment limitations (this sandbox)

- No native PHP/Composer → Laravel adapter verified locally under **PHP-WASM 8.2** (`tests/run-wasm.mjs`, 153 checks). CI runs the same suites on a **real PHP 8.2** toolchain with `illuminate/http` (real-Request integration) and `pdo_sqlite` (durability). `@php-wasm/node` is GPL-2.0 and intentionally not a committed dependency.
- No Dart/Flutter, Kotlin/Gradle, Swift/Xcode/Android SDK → Flutter/Compose/SwiftUI **blocked / not started** (ADR-0006).
- No physical Expo device → Expo verified via react-native-web + jsdom; on-device run is a documented release task.
- No public VDS Database/API/Storage/Notification/Plugin-Host builder repos → integration via real contracts + explicitly-named TEST adapters; production wiring blocked on unavailable source (Phase 0 audit).
