# Phase 0 — Reproducible baseline (2026)

This document records the **measured** state of the repository before any change in
the current implementation cycle. Every number below comes from a command that was
actually executed in this sandbox; raw logs are retained outside the repository at
`/home/user/vds-baseline-2026/` (not committed, per the repository's convention of
keeping generated evidence out of Git).

## 1. Identity

| Item | Value |
|---|---|
| Repository | `1stfoldAhmad/UNIVERSAL-Forum-Builder` |
| Baseline commit | `ab85ea7c6c96eac4b8cb9192fadfbb042abb9ae3` |
| Baseline == `origin/main` | yes (`git rev-list --left-right --count origin/main...HEAD` → `0 0`) |
| Working tree at start | clean |
| Implementation branch | `arena/ba37c6a7-universal-forum-builder` |
| Previously audited baseline | `199fbfe96657d56759e5708396da8a0c6c899aa0` (superseded by PR #5) |

### Branching deviation (declared, not silent)

The mission asks for a backup branch plus `feature/complete-universal-form-platforms`.
This session is **pinned by the hosting platform** to the branch
`arena/ba37c6a7-universal-forum-builder`; creating, renaming or switching to another
branch would dissociate the work from the session. Therefore:

- The implementation branch is the Arena session branch (already created, not `main`).
- The **backup/rollback reference is `main` at `ab85ea7`**, which is an immutable
  merge commit on the remote and is exactly the pre-change state.
- No destructive Git operation is performed.

## 2. Environment actually used

| Tool | Version | Note |
|---|---|---|
| Node.js | v22.22.3 | `engines` currently declares `>=20` |
| npm | 10.9.8 | |
| Python | 3.11.2 | single version — **not** a compatibility matrix |
| Django | 5.2.19 | installed via pip for this run |
| pytest | 9.2.0 | |
| PHP | **absent** | real PHP only in CI; local runs use PHP-WASM 8.2 |
| Dart/Flutter, JDK/Gradle, Swift | **absent** | native targets are CI-only |

## 3. Command results (actual)

| # | Command | Exit | Actual result |
|---|---|---|---|
| 1 | `npm ci` (run **before** `setup:vds`) | 0 | install succeeds but leaves an incomplete vendor shell — see §4 |
| 2 | `npm run typecheck` (after step 1) | **2** | 2 errors: `Cannot find module 'vds-json-logic'`, implicit `any` in its test |
| 3 | `npm test` (after step 1) | **1** | 27/28 files pass, **1 file fails to load**, 290 tests pass |
| 4 | `npm run cli -- conformance` | 0 | `Conformance (spec 1.0.0): 96/96 passed, 0 failed.` |
| 5 | `npm run setup:vds` | 0 | fetches + builds `vendor/vds-json-logic` |
| 6 | `npm ci --no-audit --no-fund` | 0 | correct order |
| 7 | `npm run typecheck` | **0** | clean |
| 8 | `npm test` | **0** | **28 files / 297 tests passed** |
| 9 | `npm run bench` | 0 | 7 benchmarks; rewrites `benchmarks/RESULTS.md` (reverted) |
| 10 | `npm run build:packages` | 0 | JS + declarations built |
| 11 | `npm run pack:packages` | 0 | 6 tarballs packed, nothing published |
| 12 | `npm run test:packages` | 0 | `PACKAGE SMOKE PASSED` (fresh external project) |
| 13 | `npm run test:django` | 0 | **55 passed** |
| 14 | `cd adapters/django && python3 -m pytest -q` | 0 | **10 passed** |
| 15 | `npm run test:laravel` | **127** | `sh: 1: php: not found` — environment limitation, not a code failure |
| 16 | `node execution-adapters/laravel/tests/run-wasm.mjs` | 0 | **all 10 suites / 212 assertions passed** (PHP-WASM 8.2) |

`npm run test:packages` and `pack:packages` **do not publish** anything.

### Vitest project breakdown (step 8)

| Project | Tests |
|---|---|
| `core` | 254 |
| `native` | 12 |
| `web` | 23 |
| `angular` | 8 |
| **Total** | **297** across 28 files |

### PHP suite breakdown (step 16, PHP-WASM 8.2)

| Suite | Assertions |
|---|---|
| Expression conformance (`vds.expr/1`) | 62/62 |
| Form conformance | 7/7 |
| Idempotency parity | 7/7 |
| Submission handler | 25/25 |
| Laravel controller | 20/20 |
| Security | 34/34 |
| Security policy vectors | 14/14 |
| Remediation | 21/21 |
| Operation limits | 9/9 |
| Idempotency recovery | 13/13 |
| **Total** | **212** |

The WASM runner prints, verbatim:
`note: illuminate/http not installed; real-Request integration check skipped (runs in CI).`
That skip is **explicit**, not a silent pass.

## 4. Baseline finding B-1 — setup order is load-bearing (reproducibility)

`vendor/` is gitignored and populated by `npm run setup:vds`. Running `npm ci`
first creates `vendor/vds-json-logic/node_modules` **without** the upstream source,
so `vds-json-logic` cannot resolve and both typecheck and one test file fail.

`scripts/fetch-vds-deps.sh` already detects an incomplete vendor directory and
refetches, and `.github/workflows/ci.yml` already runs `setup:vds` **before**
`npm ci`. The correct order is therefore:

```bash
npm run setup:vds && npm ci
```

This is a documentation/reproducibility hazard rather than a code defect, but it is
recorded because the mission's command list starts with a bare `npm ci`.

## 5. Existing implementation coverage at baseline

### Canonical standard
`format: "vds.form"`, `specVersion: "1.0.0"`, `vds.expr/1`, deterministic compiler →
`FormIR`. **31** built-in field contracts in
`packages/form-field-registry/src/index.ts` (including `signature`, which is
registered but **not** implemented by any renderer).

### UI renderers present
`adapters/react`, `adapters/vue`, `adapters/angular`, `adapters/expo`,
`adapters/flutter` (Dart), `adapters/compose` (Kotlin), `adapters/swiftui` (Swift).

### Server-side HTML renderers present (documented as a separate feature, ADR-0007)
`adapters/node`, `adapters/django`, `adapters/laravel`. These are **additional** to
the trusted execution adapters and share one hydration contract.

### Trusted backend execution adapters present
`execution-adapters/node` (TypeScript), `execution-adapters/django` (Python),
`execution-adapters/laravel` (PHP).

### Shared conformance fixtures present
`packages/form-conformance/fixtures/`: `expressions.json` (**62 cases**),
`forms.json` (compilation 4 / validation 4 / payload 3), `idempotency.json`,
`operation-limits.json`, `security-paths.json`.

### CI at baseline
One workflow, `.github/workflows/ci.yml`, **7 jobs**, all green on `ab85ea7`
(run `41934271314`): `typescript`, `django`, `laravel` (PHP 8.2), `laravel13`
(PHP 8.3 + Illuminate), `flutter`, `compose`, `swiftui` (macOS).

## 6. Known limitations and open defects at baseline

### Security
- **B-2 (P0, confirmed):** `execution-adapters/django/vds_form/django_view.py:83`
  applies `@csrf_exempt` **unconditionally** while also deriving identity from
  `request.user`. A cookie/session-authenticated deployment therefore accepts
  cross-site forged submissions. Must be corrected in Phase 1.
- Production VDS Database/Auth/RBAC/Storage/Notification providers do not exist;
  only explicitly named **TEST** adapters are wired. Unchanged and intentional.
- Expired idempotency claims still require host transaction/outbox reconciliation.

### Correctness
- **B-3 (P1, confirmed):** `adapters/react/src/UniversalForm.tsx` `uploadFiles()`
  accumulates refs in a local array and only calls `controller.setFieldValue(...)`
  **after** the whole loop. If any file in a batch rejects, the `catch` runs and
  **every already-uploaded asset in that batch is lost**. There is also no
  per-file error reporting, no cancellation of obsolete batches, no duplicate
  submission guard, and no MIME/size enforcement at the renderer boundary.

### Verification gaps (relative to this mission)
- No Django/Python **matrix** (single 3.11 run), no warnings-as-errors run.
- No Node **22/24/26** matrix; `engines` still `>=20` although Node 20 is EOL and
  `node:sqlite` imposes a higher real minimum.
- Laravel: real PHP 8.3 integration exists but is narrow (container + request
  parse); no real HTTP route/auth/CSRF/persistence test app, no 8.4/8.5 matrix.
- Native renderers: core runtime + conformance are CI-green, but layout coverage
  (tabs/accordion/columns/row/fieldset/summary), several field widgets, example
  apps, `flutter analyze`/`dart format` gates and accessibility tests are absent.
- No `specifications/renderer-conformance/` specification document.
- No Next.js integration example.
- No generated `PLATFORM_SUPPORT_MATRIX.md`.
- Packaging evidence exists for npm only (no wheel / composer validate /
  pub dry-run / Gradle publish-to-local / Swift build artifacts).
- Physical-device verification: **pending** (no devices available; never claimed).

## 7. Baseline integrity

No baseline test was deleted, skipped or weakened to obtain these numbers. The only
working-tree mutations produced by the baseline runs were `benchmarks/RESULTS.md`
(rewritten by `npm run bench`) and the file mode of `tools/cli/src/bin.ts` (flipped
by npm); **both were reverted** with `git checkout --` and the tree was confirmed
clean before Phase 1 began.
