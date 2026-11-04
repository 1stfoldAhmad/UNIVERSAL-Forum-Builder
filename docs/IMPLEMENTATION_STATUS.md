# Implementation ledger — VDS Universal Form Builder

Status labels: `not-started` · `in-progress` · `implemented` · `verified` · `blocked` · `unsupported`.
A row is **verified** only when its acceptance criteria passed via the recorded command.
This ledger is updated after every phase; final narrative audit: `docs/FINAL_IMPLEMENTATION_AUDIT.md`.

Last updated: 2026-11-04 (Phase 0)

## Acceptance-criteria tracker (spec §30)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| R01 | Original Expo SDK 58 repo works independently | verified | Baseline `npm ci && npm test` in unmodified snapshot: 15 files / 92 tests pass (`docs/audit/PHASE0_SOURCE_AUDIT.md`) |
| R02 | Universal builder exists as separate product | verified | This workspace; reference repo untouched (ADR-0001/0004) |
| R03 | One canonical versioned JSON spec published | not-started | — |
| R04 | JSON Schema validation works | not-started | — |
| R05 | Compiler produces normalized FormIR | not-started | — |
| R06 | Headless runtime without UI framework | not-started | — |
| R07 | Conditions/formulas execute safely | not-started | — |
| R08 | Validation consistent | not-started | — |
| R09 | Dynamic dependencies update correctly | not-started | — |
| R10 | Nested forms and repeaters work | not-started | — |
| R11 | Submission delegates to registered real operations | not-started | — |
| R12 | Missing executors → explicit errors | not-started | — |
| R13 | Database/API integrate via their own VDS contracts | blocked | No public VDS Database/API Builder source (Phase 0); provider contracts + test adapters planned |
| R14 | Auth/RBAC enforced by trusted execution | not-started | — |
| R15 | Storage/uploads via registered providers | not-started | — |
| R16 | Workflow integration uses Workflow Builder | not-started | Real target discovered: `vds-json-logic` |
| R17 | Draft persistence + approved offline queue | not-started | — |
| R18 | Expo rendering verified | not-started | — |
| R19 | React/Angular/Vue renderers verified | not-started | — |
| R20 | Flutter/Compose/SwiftUI at declared conformance | blocked | No Dart/Kotlin/Swift toolchains or distribution hosts in sandbox (ADR-0006) |
| R21 | Node/Django/Laravel equivalent contract tests | not-started | PHP runtime absent; static-binary attempt planned |
| R22 | AI/MCP/Plugin Host tools permission-controlled | not-started | VDS Plugin Host source unavailable → standalone MCP + blocked host wiring |
| R23 | Migrations tested | not-started | — |
| R24 | Security tests pass | not-started | — |
| R25 | Accessibility/localization contracts implemented | not-started | — |
| R26 | Examples installable/runnable | not-started | — |
| R27 | Documentation matches implementation | in-progress | Phase 0 audit + ADRs written |
| R28 | CI reproducible evidence | not-started | — |
| R29 | Unsupported capabilities documented | in-progress | ADR-0006, Phase 0 audit |
| R30 | No fake-success/placeholder presented as complete | in-progress | Policy enforced by ADR-0005/0006 |

## Package ledger

| Requirement | Package/path | Status | Sources | Tests | Verification command | Result | Limitation |
|---|---|---|---|---|---|---|---|
| Phase 0 audit | docs/audit, docs/adr | verified | PHASE0_SOURCE_AUDIT.md | reference baseline | `npm ci && npm test` (reference snapshot) | 92/92 pass | On-device native checks not run here |

(Rows added per phase below.)
