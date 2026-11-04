# ADR-0004 — Reuse, attribution and preservation of the Expo library

Status: accepted · 2026-11-04

## Decision
- `Native-JSON-form-Builder` (Apache-2.0) is **audited, baseline-tested (92/92), and left
  untouched**. It keeps its own format, APIs, publishing model and Expo SDK 58 target.
- The universal core is a clean implementation of the new standard. Concepts adapted from
  the reference (wildcard paths, `$item/$parent/$index` scoping, evaluation budgets, draft
  envelope versioning, lifecycle state machines, RN-web test aliasing) are attributed in
  `NOTICE` as required by Apache-2.0 §4.
- `vds-json-logic` (Apache-2.0) is integrated **as a real dependency built from source**
  (not published on npm): the `logic:` submission executor delegates to
  `LogicEngine.callFunction/executeFlow` and maps `ExecutionResult` to normalized results.
- No code with unknown/incompatible licensing is copied.

## Consequences
Compatibility of the source library is preserved by construction; universal semantics are
free to evolve under their own spec version.
