# ADR-0005 — Submission execution & VDS integration boundaries

Status: accepted · 2026-11-04

## Decision
- The runtime **never** performs HTTP or DB I/O itself. `submit()` resolves
  `submission.operationRef` against a `SubmissionExecutorRegistry`; missing executor →
  structured `SUBMISSION_EXECUTOR_NOT_REGISTERED`; unresolved operation →
  `SUBMISSION_OPERATION_UNRESOLVED`. No generic endpoint exists anywhere in this repo.
- Operation ref schemes: `api:`, `database:`, `workflow:`, `logic:`, `storage:`,
  `notification:`, `test:` — each resolved only by a registered executor for that scheme.
- **Real integration:** `logic:`/`workflow:` execute through `vds-json-logic`
  (`integrations/vds-logic`), built from the actual source; results map 1:1 from
  `ExecutionResult`. Auth context shape follows `expo-app-foundation` contracts.
- **Blocked integrations:** no VDS Database/API/Storage/Notification/RBAC builder or Plugin
  Host/MCP host repositories exist publicly (Phase 0 discovery). We ship explicit provider
  contracts + clearly-named test adapters (`integrations/vds-contracts`) and a standalone
  MCP server (official SDK). Wiring to a future VDS host is documented as blocked, never invented.
- Trusted server adapters (Node/Django/Laravel) re-validate and re-authorize every submission;
  client-side hiding is never authorization. Idempotency keys + single-flight locks prevent
  duplicates; offline queueing only when the operation contract allows it, and a queued
  submission is never reported as server success.


## Addendum — independent-audit remediation (2026-11-04)

- Sensitive registry fields are stripped from drafts/offline queues by default; explicit `includeSensitive` opt-in only.
- Operation inputs enforce recursive depth/node/string/array/object limits and forbidden names at every depth (TS/Python/PHP parity fixture).
- Idempotency claims carry leases. Expired claims return `IDEMPOTENCY_RECOVERY_REQUIRED`; hosts must reconcile via transaction/outbox (`complete` if committed, `release` only if provably not committed). No unsafe automatic re-execution.
- Durable persistence references: Node SQLite draft/queue/idempotency; browser/Expo KeyValue adapters. Memory adapters are explicitly non-durable.
