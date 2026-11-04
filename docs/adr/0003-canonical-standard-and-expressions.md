# ADR-0003 — Canonical document & expression language

Status: accepted · 2026-11-04

## Decision
- One canonical document: `format: "vds.form"`, `specVersion: "1.0.0"`, validated by a
  JSON Schema **Draft 2020-12** (`specifications/json-schema/vds-form-1.0.0.schema.json`)
  plus semantic compiler passes. Platform adapters never define their own canonical format.
- Expressions are a **typed JSON AST** (`vds.expr/1`): `{op, args}` nodes with `const`,
  `ref` (field/context/item/parent/source/index), and a closed operator set. This is the
  cross-language contract (TS, Python, PHP, and future Dart/Kotlin/Swift consume the same AST).
- A small **text DSL** (`qty * price`, `AND(a, b)`, `$item.x`, `items.*.amount`) exists only
  as authoring sugar in the TS toolchain; it compiles to the canonical AST at build time.
  The reference library's formula syntax informed the scoping tokens (attribution in NOTICE).
- **No `eval`, `new Function`, or host-code strings anywhere.** Evaluators enforce node,
  depth, collection-size and string-length budgets and a closed function registry.
- Null/type semantics are explicit: arithmetic requires finite numbers (type error otherwise),
  comparisons are strict, `coalesce`/`if` provide explicit null handling; errors are values
  (`{ok:false, code}`), never thrown across adapter boundaries.

## Consequences
Cross-language conformance is testable with shared JSON fixtures; renderers never reinterpret
source logic; old text-only formulas cannot silently change meaning.
