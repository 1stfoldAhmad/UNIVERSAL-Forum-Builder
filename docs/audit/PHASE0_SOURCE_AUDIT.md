# Phase 0 — Source-backed repository audit & integration discovery

Date: 2026-11-04 · Auditor: Arena agent · Method: direct source inspection of fetched
`main` snapshots + executed baseline test run. No source in any reference repository was modified.

## 1. Reference Expo library: `1stfoldAhmad/Native-JSON-form-Builder`

Snapshot: `main` tarball via codeload.github.com, extracted read-only to
`/home/user/reference/Native-JSON-form-Builder-main` (outside this repository).

- Package: `native-json-form-builder@1.0.0`, **Apache-2.0**, ESM, `main: dist/index.js`,
  source-first `expo-source` export condition. **Not published on npm** (registry 404 on 2026-11-04).
- Peer dependencies: `expo >=58`, `@expo/ui >=58`, `react >=19`, `react-native >=0.81`;
  optional `expo-image-picker`, `expo-document-picker`, `react-dom`, `react-native-worklets`.
  Dev pins: expo ~58.0.21, RN 0.88.1, react 19.3.0, `@expo/ui` ~58.0.25, vitest ^3.2.7.
- Runtime deps: `ajv ^8.20.0`, `ajv-formats ^3.0.1` only.
- Expo SDK 58 **exists on npm** (`expo@58.0.23` latest, `sdk-57`, `sdk-56`… dist-tags verified).

### 1.1 Baseline test run (unmodified source)

```
cd reference/Native-JSON-form-Builder-main && npm ci && npm test
→ Test Files  15 passed (15) · Tests  92 passed (92) · Duration 23.73s
Environment: Node v22.22.3, npm 10.9.8, vitest 3.x, jsdom, react-native→react-native-web alias.
```

Known baseline warnings: React `act(...)` warnings from `SearchablePicker` tests (pre-existing, non-failing).

### 1.2 Implemented functionality inventory (source evidence)

| Area | Evidence (files) | Assessment |
|---|---|---|
| Public API | `src/index.ts` exports components, hooks, parser, builder, registries, engine, compiler, validation, workflows, persistence, tooling | Implemented, exercised by `tests/public-api-baseline.test.ts` |
| JSON Schema | `schema/expo-form.schema.json` — Draft 2020-12, `$id https://1stfold.dev/schemas/expo-form/v1.json`, AJV + ajv-formats; supports `fields` / `sections` / `steps` documents, embedded layer-1 `schema`, i18n `LocalizedText` | Implemented |
| Field catalog | `src/fields/FieldRegistry.ts` enumerates **88 built-in types** (categories A–G) + aliases; 8 category renderer modules (`TextPersonalFields`, `NumericFields`, `SelectionFields`, `DateTimeFields`, `AddressLocationFields`, `FileUploadFields`, `BarcodeScannerField`, `StructuralFields`) | Declared 88; rendered via category dispatch; `forms/all-fields-showcase.json` + gallery tests pass in jsdom/RN-web. **On-device native behavior not verified in this audit** (repo ships `.maestro` smoke + `native-verify.yml` CI for that) |
| Compiler | `src/compiler/SchemaCompiler.ts`, `fingerprint.ts` — `compileFormSchema`, canonical stable stringify, FNV-1a fingerprints, compiled plan cache | Implemented |
| Dependency graph | `src/engine/DependencyGraph.ts` — edges, evaluation plan, wildcard template paths | Implemented |
| Formula engine | `src/formula/{tokenizer,parser,evaluator,functions}.ts` — text DSL, AST depth/length/token limits, function registry, `$item.*`/`$parent.*`/`$index` row scope, `items.*.amount` wildcards, injectable clock | Implemented; **text-DSL based** (not a JSON AST) |
| Conditions | `src/conditions/evaluator.ts` — structured clauses, visibility/enabled/readonly/required derivation, path extraction, dependency graph build | Implemented |
| Validation | `src/validation/ValidationEngine.ts`, `AsyncValidationManager.ts` (debounce, server error normalization), `passwordStrength`, `patterns` | Implemented |
| Data sources | `src/datasources/DataSourceManager.ts` — fetch-like injection, auth header provider, URL interpolation, option mapping | Implemented (URL-based; universal standard replaces URLs with operation refs) |
| Drafts | `src/persistence/DraftManager.ts` — envelope v1, version-conflict context | Implemented |
| Offline queue | `src/persistence/OfflineSubmissionQueue.ts` — statuses, attachments, transport outcome | Implemented |
| Submission lifecycle | `src/workflows/SubmissionLifecycle.ts` — 9-state machine + audit history; `ApprovalWorkflowEngine.ts`, `StepWorkflowController.ts` | Implemented (client-side orchestration; no server executor contract) |
| RBAC | `src/workflows/PermissionsPolicy.ts` — `evaluatePermissionRule`, server permission manifest extraction | Implemented as policy evaluation helper; enforcement is host responsibility |
| Uploads | `src/uploads/UploadAdapter.ts` — constraints resolution, file validation, server upload policy manifest | Implemented |
| Plugins | `src/plugins/PluginRegistry.ts`, `MiddlewarePipeline.ts` | Implemented |
| Migration/tooling | `src/tooling/schemaMigrator.ts` — `diffFormSchemas`, `validateMigrationChain`; `typeGenerator.ts` | Implemented |
| Inspection | `src/devtools/FormDiagnostics.ts`, `PerformanceProfiler.ts`; `remote/RemoteSchemaManager.ts` | Implemented |
| Tests/fixtures | 15 test files / 92 tests; 11 example form JSONs; Expo example app (`example/`) with expo-router screens | Implemented; all pass at baseline |

### 1.3 Reuse decision

The library is Apache-2.0 (reuse permitted with NOTICE attribution). Its **document format,
text-DSL formulas and Expo-coupled renderer are not the universal standard**. We reimplement
the platform-independent core against the new canonical JSON AST standard, and *adapt proven
concepts* (wildcard collection paths, repeater row scoping `$item/$parent/$index`, evaluation
budgets, draft envelopes, submission state machines). Attribution recorded in `NOTICE`.
**No files were copied into the reference repo and no reference source was modified.**

## 2. VDS ecosystem discovery (actual repositories inspected)

| Repo / package | Evidence | Usable contract |
|---|---|---|
| `NATIVE-JSON-FLOW-LOGIC-Builder` → **`vds-json-logic@0.1.0`** (Apache-2.0, not on npm) | `src/engine.ts`, `src/result.ts`, `src/flows/executor.ts` | **Real execution engine**: `LogicEngine.load(specs)`, `callFunction(id, args, {signal,user,environment})`, `callMethod`, `executeFlow(flowId, {input,signal,timeoutMs,user,…})` → `ExecutionResult { success, data?, error?{code,message,details}, executionId, duration }`; frontend/backend environments, capability grants, evaluation budgets, no eval |
| `JSON-Native-AUTH-Navigation-Builder` → `expo-app-foundation` | `packages/contracts/src/provider-contract/index.ts`, core `evaluateAccessPolicy()` | **Real auth contracts**: `AuthProviderAdapter` (signIn/restoreSession/refreshSession…), `AuthSession`, claims/roles; access-policy evaluation |
| `Native-JSON-LAYOUT-Builder` | README only | **No implementation exists** — nothing to integrate |
| VDS Database Builder / API Builder / Storage Builder / Notification Builder / standalone RBAC Builder / **VDS Plugin Host / MCP registration / UAD project model** | Not present under `github.com/1stfoldAhmad` (repo list enumerated via API on 2026-11-04) | **No source available → real wiring is BLOCKED.** Universal provider contracts + explicitly-named test adapters are implemented instead; no VDS API is invented |

## 3. Build environment (this sandbox)

- Node v22.22.3, npm 10.9.8, Python 3.11.2, pip 23.0.1 — available.
- **Not available:** PHP, Composer, Dart, Flutter, Kotlin, Gradle, Swift, Android SDK, Xcode.
- Network allowlist: github.com, codeload.github.com, api.github.com, registry.npmjs.org,
  pypi.org, files.pythonhosted.org. (No packagist, no storage.googleapis.com, no swift.org.)
- Consequences: Flutter/Compose/SwiftUI renderers **cannot be built or verified here**;
  Laravel adapter PHP execution requires a static PHP binary (attempted; see ledger);
  Django adapter fully verifiable via PyPI.

## 4. Phase 0 exit gate

- [x] Source-backed inventory (above) with executed baseline (92/92 pass).
- [x] Integration discovery report (real `vds-json-logic` + auth contracts; missing builders documented).
- [x] Architecture decision records: `docs/adr/0001…0006`.
- [x] Universal project created in the session checkout; reference repo untouched.

**Gate: PASSED** (with explicitly documented blocked external integrations).
