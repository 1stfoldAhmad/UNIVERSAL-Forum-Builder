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
