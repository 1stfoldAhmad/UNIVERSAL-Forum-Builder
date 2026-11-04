# VDS Universal Form Builder

One canonical, versioned JSON form standard (`vds.form`) with a deterministic compiler,
a safe expression/formula engine, a headless runtime, and independently implemented
platform adapters (renderers + trusted execution adapters).

> Repository note: this codebase lives in the `UNIVERSAL-Forum-Builder` checkout provided
> for this session (the intended product name is **VDS-Universal-Form-Builder**; renaming
> the GitHub repository is an owner action). The original Expo library
> `1stfoldAhmad/Native-JSON-form-Builder` is a **separate, untouched product**.

## Architecture in one line

```
form.vds.json → Schema validation → Compiler → FormIR → Headless Runtime
   → Renderer adapters (React / Vue / Angular / Expo)
   → Registered SubmissionExecutor (Node / Django / Laravel / vds-json-logic) → real result
```

There is **no generic submission endpoint and no eval**: every submission resolves a
registered operation and delegates to a registered executor; missing executors fail with
`SUBMISSION_EXECUTOR_NOT_REGISTERED`. Form logic is a typed JSON AST (`vds.expr/1`).

## Workspace layout

| Area | Path | Status |
|---|---|---|
| Specification + JSON Schema | `specifications/`, `packages/form-spec` | see ledger |
| Shared contracts/types | `packages/form-types` | see ledger |
| Expression & formula engine | `packages/form-expressions` | see ledger |
| Compiler / FormIR | `packages/form-compiler` | see ledger |
| Validation engine | `packages/form-validation` | see ledger |
| Headless runtime | `packages/form-runtime` | see ledger |
| Field registry & capabilities | `packages/form-field-registry` | see ledger |
| Data sources / persistence / submission | `packages/form-data-sources`, `form-persistence`, `form-submission` | see ledger |
| Plugins / inspector / migrations | `packages/form-plugin-sdk`, `form-inspector`, `form-migrations` | see ledger |
| Conformance fixtures | `packages/form-conformance` | see ledger |
| Renderers | `adapters/react`, `adapters/vue`, `adapters/angular`, `adapters/expo` | see ledger |
| Trusted execution | `execution-adapters/node`, `execution-adapters/django`, `execution-adapters/laravel` | see ledger |
| VDS integrations | `integrations/vds-logic` (real), `integrations/vds-contracts` | see ledger |
| CLI / MCP tools | `tools/cli`, `tools/mcp-server` | see ledger |
| Examples | `examples/*` | see ledger |

**Truthful status lives in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)**
and the audit in [`docs/FINAL_IMPLEMENTATION_AUDIT.md`](docs/FINAL_IMPLEMENTATION_AUDIT.md).
Nothing is marked verified without executed test evidence.

## Quick start

```bash
npm install
npm test            # all TypeScript suites (core, renderers, integrations, tools)
npm run typecheck
npm run cli -- validate examples/forms/customer-registration.vds.json
npm run cli -- compile examples/forms/customer-registration.vds.json
npm run bench       # performance evidence
```

Python execution adapter:

```bash
cd execution-adapters/django && pip install -r requirements-dev.txt && python -m pytest
```

## License

Apache-2.0 (see `LICENSE`, `NOTICE`).
