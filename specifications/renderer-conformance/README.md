# Renderer conformance contract (v1)

This contract supplements (does not replace) the canonical `vds.form` JSON Schema, compiled FormIR, canonical field registry, and shared conformance fixtures. Implementations must consume the canonical contract; platform-specific schemas are not conformant.

## Semantic requirements

1. **Values:** preserve JSON types. Text-like controls produce strings; integer/decimal produce JSON numbers; booleans produce booleans; selections produce option values (arrays for multi-select); dates/times use canonical string representations; file/image controls produce asset-reference objects, never local file bytes or a trusted URL inferred by the client. Empty optional values use the field's canonical default or absence; renderers must not invent cross-platform coercions.
2. **Normalization:** trim/case conversion only where the canonical field configuration explicitly requests it. Invalid numeric text must remain an input error, not silently become zero. Unknown properties and unknown field types must not be silently accepted as another type.
3. **State:** `required`, `readonly`, `disabled` and hidden are distinct. Readonly values remain visible and non-editable; disabled controls are non-interactive; required validation is shared semantic behavior. Hidden descendants are omitted from submission according to canonical policy, not merely CSS-hidden.
4. **Validation:** renderer feedback is a presentation of shared validation results. Server validation remains authoritative. Stable issue codes and paths are retained; native control limitations must be disclosed as partial rather than weakening validation.
5. **Expressions:** conditions, dynamic required/visibility, computed formulas and dynamic options use the safe canonical expression engine and the same evaluation order/budgets. No `eval`, `Function`, or platform-specific expression dialect.
6. **Composition:** groups preserve nested object paths; repeaters preserve stable row identity and ordered values on add/remove/move; steps preserve canonical step order and validate according to the canonical navigation policy. Sections, rows/columns, containers, summaries, tabs/accordions and visibility-bearing layout nodes follow only the JSON Schema/FormIR definitions currently present.
7. **Uploads:** file/image output is a provider-issued asset reference. Apply max-size and accept constraints using filename extension for extension tokens and normalized MIME for MIME tokens. MIME metadata is advisory; the trusted provider validates actual content. Preserve an item when identity is unavailable; deduplicate only on stable provider/native identity.
8. **Submission:** use the headless runtime and registered operation boundary. Model submitting, validation failure, permission denial, business rejection, network/timeout, success and replay distinctly. Prevent concurrent duplicate operations and keep idempotency keys bound to the exact unresolved payload.
9. **Localization/accessibility:** labels, help, errors and option labels use localization fallbacks; controls have programmatic labels, keyboard/native focus behavior and announced errors. Missing platform affordances are Partial/Unsupported in capability metadata.
10. **Capability negotiation:** each capability declares status (`supported`, `partial`, `unsupported`, `requires-host-adapter`) plus any required adapter. A claim requires functional controls and tests, not just a type declaration or successful build.

## Shared fixture expectation

Conformance inputs and expected semantic values belong in `packages/form-conformance/fixtures` and are consumed unchanged by each platform implementation where its runtime supports execution. Platform UI tests must additionally exercise actual controls. A renderer may explicitly report unsupported behavior, but may not substitute a generic text control and call the canonical type supported.

## Current status

This document establishes the shared contract; this commit does **not** establish full six-language/native conformance. See `docs/PLATFORM_SUPPORT_MATRIX.md` and `docs/audit/FINAL_COMPLETION_AUDIT_2026.md` for measured status and outstanding work.
