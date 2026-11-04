# Independent audit remediation — 2026-11-04

Repository: `1stfoldAhmad/UNIVERSAL-Forum-Builder`
Remediation branch: `arena/a98c1e4e-universal-forum-builder` (Arena-created; no additional branch was created).
Baseline commit: `521644e1829db469def24cfc3f712761a9e6fcf1` (`origin/main`).
Publication state: remediation pull request on this branch for review. **No merge is authorized or performed.**
Original `Native-JSON-form-Builder` repository: not present in this checkout and not modified.
No platform targets were added.

## Stage 1 — baseline (recorded before source changes)

Documents read: `README.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/FINAL_IMPLEMENTATION_AUDIT.md`, `docs/audit/SECURITY_FIXES_2026-11-04.md`, `docs/audit/PHASE0_SOURCE_AUDIT.md`, ADR-0001 through ADR-0006.

| Suite | Command | Actual baseline result |
|---|---|---|
| TypeScript | `npx vitest run` | 234/234 pass, 20 files |
| Typecheck | `npm run typecheck` | 0 errors |
| Cross-language conformance | `npx tsx tools/cli/src/bin.ts conformance` | 73/73 pass |
| Django | `cd execution-adapters/django && python3 -m pytest -q` | 42/42 pass |
| Laravel (PHP-WASM 8.2) | `node execution-adapters/laravel/tests/run-wasm.mjs` | 155/155 pass, 6 suites |
| React example build | `cd examples/react-app && npx vite build` | 248 modules, build succeeded |

Baseline evidence was recorded in the sandbox before source changes (commands and counts below; logs are not committed).

## Stage 2 — hidden-field stripping

**Original finding:** hidden stripping only handled top-level/plain-object paths. Concrete repeater paths such as `items.0.secret` did not match template paths such as `items[].secret`; arrays/repeater rows and parent mappings could carry hidden descendants.

**Files changed:**
- `packages/form-validation/src/policy.ts` (new shared TS policy)
- `packages/form-submission/src/index.ts`
- `execution-adapters/django/vds_form/policy.py` (new)
- `execution-adapters/django/vds_form/payload.py`
- `execution-adapters/laravel/src/Policy.php` (new)
- `execution-adapters/laravel/src/Payload.php`
- `packages/form-conformance/fixtures/security-paths.json` (new shared vectors)

**Root cause:** path matching was string-prefix based and did not normalize concrete array indices to repeater template wildcards; recursion skipped arrays.

**Correction:** a shared path policy normalizes `items.0.secret`, `items[0].secret`, and `items[].secret` to the same template segments. Hidden subtrees are removed recursively from objects, arrays, repeater rows, groups-in-repeaters, repeaters-in-groups, and multi-level template paths. Parent `inputMapping` values are cleaned before mapping, so a mapped parent cannot reintroduce hidden descendants. Visible siblings (including explicit nulls) are preserved; Python/PHP use a removal sentinel so null is not confused with a stripped hidden value. Unsafe prototype keys are dropped/rejected by the unknown-property policy.

**New tests:** shared `security-hidden` vectors (TS/Python/PHP), `tests/remediation.test.ts` Stage 2 (compiled repeater/group forms, parent mapping, nested-repeater template normalization).

**Result:** verified locally in TS, Django, and PHP-WASM.

**Limitation:** the canonical compiler still rejects nested repeaters inside repeaters for spec 1.0.0 authoring (`FIELD_KEY_INVALID`). The nested-repeater security vectors verify the shared path policy defensively at the FormIR/template level; they do not claim end-to-end compiled nested-repeater authoring support.

## Stage 3 — strict undeclared-property rejection

**Original finding:** trusted handlers and payload builders ignored unknown submitted properties; reverse `inputMapping` dropped unmapped parameters silently; there was no typed contract for non-field operation inputs.

**Files changed:**
- `packages/form-types/src/index.ts` (`OperationInputDef`, `SuccessHookDef`, `SubmissionDef.operationInputs`)
- `specifications/json-schema/vds-form-1.0.0.schema.json` (`operationInput`, submission/hook `operationInputs`)
- `packages/form-validation/src/policy.ts`
- `packages/form-submission/src/index.ts`
- `packages/form-runtime/src/index.ts` (runtime validation now reports unknown field properties)
- `execution-adapters/node/src/index.ts`
- `execution-adapters/django/vds_form/policy.py`, `submission.py`, `payload.py`
- `execution-adapters/laravel/src/Policy.php`, `Submission.php`, `Payload.php`

**Root cause:** request payloads were forwarded/reconstructed without a default-deny property policy; operation-specific inputs had no declared shape.

**Correction:** trusted submission paths now reject undeclared root properties, nested group properties, repeater-row properties, and prototype-pollution keys (`__proto__`, `prototype`, `constructor`) before operation execution. Mapping modes accept only declared mapping keys plus declared `operationInputs`; mapped source values are reconstructed into field-keyed values and revalidated against the field tree. Identity mode accepts only declared field roots plus declared `operationInputs`.

`operationInputs` is the documented typed contract for non-field inputs:
```json
{
  "submission": {
    "operationRef": "test:contact.create",
    "operationInputs": {
      "meta": {
        "valueType": "object",
        "properties": { "source": { "valueType": "string" } }
      }
    }
  }
}
```
Unknown members are rejected unless a schema explicitly sets `additionalProperties: true`. Required/type violations produce structured issues. Executed payloads are rebuilt from cleaned values; the raw request is not forwarded.

**New tests:** shared `security-unknown` vectors; Node/Django/PHP trusted-handler mass-assignment, nested/repeater unknown-property, prototype-pollution, and typed operation-input tests; runtime unknown-property validation.

**Result:** verified locally in TS, Django, and PHP-WASM.

## Stage 4 — field-level read authorization

**Original finding:** `SecurityDef.fieldAccess.read` existed but was not enforced. Visibility/disabled/readonly were UI state, not security. Unauthorized values could appear in runtime values, snapshots, inspection, options, and operation results.

**Files changed:**
- `packages/form-validation/src/policy.ts` (`computeReadPolicy`, `filterReadableValues`)
- `packages/form-runtime/src/index.ts`
- `execution-adapters/node/src/index.ts`
- `execution-adapters/django/vds_form/policy.py`, `submission.py`
- `execution-adapters/laravel/src/Policy.php`, `Submission.php`

**Root cause:** read permissions were never evaluated; only write permissions and submit permissions were checked.

**Correction:** read policy is evaluated fail-closed. If read permissions are declared and auth/evaluator is missing, or evaluation fails, the field is denied. Denied field values are removed from runtime initial/loaded values, `getValues`, `getFieldValue`, field slices, snapshots, dirty/touched/focus metadata, issues, options, and data-source option projections. Trusted handlers filter read-protected fields from successful operation result data before returning/caching it, and re-filter idempotent replays under the current principal’s read permissions. Visibility/disabled/readonly are not consulted as authorization.

Write-only behavior is preserved: a field may be writable but unreadable; submission can carry a write-only value if write authorization permits, but result data/read surfaces do not expose it. Field-level write checks now evaluate concrete repeater instances and treat explicit null as a provided value, so protected repeater children cannot be cleared without write permission.

**New tests:** shared `security-read` vectors; runtime initial/snapshot/field-slice/options/result redaction; unresolved fail-closed test; Node/Django/PHP trusted-handler result filtering; idempotent replay re-filtering after read-permission revocation; repeater-row read vector; concrete repeater write protection including null.

**Result:** verified locally in TS, Django, and PHP-WASM.

**Limitation:** host data-source providers must still enforce their own backend query authorization. The runtime redacts option projections and snapshot exposure, but a provider returning unauthorized records to a client host is outside the form runtime's trust boundary.

## Stage 5 — plugin trust boundary

**Original finding:** `PluginHost` accepted `trust: 'sandboxed'` without isolation, had no revocation/cleanup, silently skipped missing registries, and stored mutable manifests.

**Files changed:**
- `packages/form-plugin-sdk/src/index.ts`
- `packages/form-types/src/index.ts` (`trust` union includes `untrusted`)
- `packages/form-field-registry/src/index.ts`, `packages/form-submission/src/index.ts`, `packages/form-data-sources/src/index.ts` (unregister support)

**Root cause:** the host treated manifest trust labels as metadata rather than an enforceable boundary and applied registrations without transactional cleanup.

**Correction:** no sandbox is claimed. `trust: 'sandboxed'` and `trust: 'untrusted'` are rejected with `PLUGIN_SANDBOX_UNSUPPORTED` before side effects. Trusted host-registered code is distinguished from rejected sandboxed manifests. Omitted trust remains legacy host-registered trusted code and is normalized to `trusted` in host listings.

The host now enforces per-plugin grants (`pluginPermissions`), capability allowlists by registration kind, immutable manifest copies, required-registry fail-closed behavior, transactional registration rollback, and dependency-aware `unregister(pluginId, { cascade })`. Revocation removes field/executor/provider/expression-function registrations. Active dependents block non-cascade revocation.

**New tests:** sandboxed/untrusted rejection without side effects, per-plugin permission escalation, immutable manifest copies, dependency-active/cascade cleanup, missing registry fail-closed.

**Result:** verified locally in TypeScript.

**Limitation:** this is an explicit rejection boundary, not a real sandbox. A future isolated adapter would need separate implementation and verification.

## Stage 6 — UI auth vs trusted server principal

**Original finding:** runtime `opts.auth` was forwarded as `SubmissionContext.authenticatedContext`, and `createNodeExecutor` passed that context to the trusted handler. Browser-supplied identity could become backend identity in in-process execution.

**Files changed:**
- `packages/form-runtime/src/index.ts` (`uiAuth`, deprecated `auth` alias; no `authenticatedContext` forwarding)
- `packages/form-types/src/index.ts` (`SubmissionContext.authenticatedContext` trusted-only contract)
- `execution-adapters/node/src/index.ts` (`NodeExecutorOptions.auth` / `resolveAuth`)
- `integrations/vds-logic/src/index.ts` (`VdsExecutorOptions.auth` / `resolveAuth`)
- `packages/form-submission/src/index.ts` (offline replay no longer forwards caller auth as identity)
- `execution-adapters/node/tests/trusted.test.ts` (e2e uses server-configured principal)

**Root cause:** a single auth context was used for UI pre-checks/draft scoping and trusted execution identity.

**Correction:** runtime UI auth (`uiAuth`, legacy `auth`) is used only for client-side pre-checks and draft scoping. The runtime never populates `SubmissionContext.authenticatedContext`. Node and VDS logic/workflow executors obtain identity from server-side executor configuration (`resolveAuth` preferred, `auth` captured by trusted host) or direct `handler.handle(request, serverAuth)` calls. HTTP Django/Laravel boundaries continue to derive identity from framework principals/validated claims and reject body `auth`.

**New tests:** forged runtime UI admin permissions cannot grant trusted Node execution; forged `SubmissionContext.authenticatedContext` is ignored by the Node executor; existing body-auth forgery tests remain green.

**Result:** verified locally in TypeScript; Django/Laravel HTTP body-auth rejection suites remain green.

**Limitation:** in-process executors are only as trustworthy as the host that constructs them. Hosts must supply verified principals; the form runtime intentionally cannot mint backend identity.

## Stage 7 — verification (actual executed results)

Evidence: the commands and actual counts below were re-executed before opening the pull request. Sandbox logs are not committed.

| Suite | Command | Actual result |
|---|---|---|
| TypeScript | `npx vitest run` | **254/254 pass**, 21 files |
| Typecheck | `npm run typecheck` | **0 errors** |
| Cross-language conformance | `npx tsx tools/cli/src/bin.ts conformance` | **87/87 pass** |
| Django | `cd execution-adapters/django && python3 -m pytest -q` | **51/51 pass** |
| Laravel (PHP-WASM 8.2) | `node execution-adapters/laravel/tests/run-wasm.mjs` | **190/190 pass**, 8 suites |
| React example build | `cd examples/react-app && npx vite build` | 249 modules, build succeeded |

PHP-WASM suites: expression 62, form conformance 7, idempotency parity 7, submission handler 25, controller 20, security 34, security-policy vectors 14, remediation 21. The real-Illuminate check is skipped locally and remains mandatory in CI via `VDS_REQUIRE_ILLUMINATE=1` / `VDS_REQUIRE_PDO_SQLITE=1`.

CI configuration: `.github/workflows/ci.yml` already runs TypeScript, typecheck, conformance, React build, Django, and Laravel `composer test`. Laravel `composer test` now includes the new security-policy and remediation suites.

**Real-PHP CI status:** the remediation pull request triggers the configured real PHP 8.2 + Illuminate/PDO CI job. This document records local sandbox evidence only; the PR check run is the authoritative real-PHP result and must pass before merge.

## Stage 8 — remaining blockers / honest limitations

1. **Real-PHP CI must pass on the pull request.** Local PHP-WASM verification is complete; the native PHP 8.2 + Illuminate/PDO CI run is the remaining external verification gate before merge.
2. **Nested repeater authoring remains spec-limited.** Security path normalization handles nested repeater templates defensively, but the compiler still rejects nested repeaters in spec 1.0.0. No platform/spec expansion was made.
3. **No plugin sandbox exists.** Sandboxed/untrusted plugins are rejected, not isolated.
4. **Production VDS Database/API/Storage/Notification/Plugin-Host integrations remain contract-level.** No unavailable upstream source was invented; TEST adapters remain explicitly named.
5. **Flutter/Compose/SwiftUI/native Expo device behavior remain unverified.** No new platform targets were added; existing Expo verification remains RN-web/jsdom.
6. **Host-side provider authorization remains a host responsibility.** Runtime read redaction does not replace backend data-source query authorization.

No coverage was reduced and no existing assertions were weakened. All baseline suites remain green with additional adversarial coverage.
