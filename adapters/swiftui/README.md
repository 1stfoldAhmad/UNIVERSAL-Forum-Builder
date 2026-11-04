# @vds-form/swiftui — native SwiftUI renderer (Swift)

A faithful Swift port of the canonical form runtime plus a native SwiftUI UI,
as a Swift package with two targets:

- **`VdsForm`** (Foundation only, cross-platform core):
  - `Expressions.swift` — `vds.expr/1` engine (closed operators, budgets, refs,
    error-as-value). Verified against **all 62 shared conformance cases**.
  - `Validation.swift` — effective state, repeater expansion, validation.
  - `Controller.swift` — headless `FormController` (conditions, formulas,
    repeaters, multi-step, drafts/uploads adapters, trusted transport submit).
  - `Capabilities.swift` — capability manifest.
- **`VdsFormUI`** (SwiftUI): `VdsFormView` rendering every supported field type,
  groups, repeaters, steps, errors, i18n and a11y.

Submission is delegated to an injected **trusted transport**; the client never
executes business operations and never sends authoritative identity.

## Usage

```swift
let controller = FormController(ir: compiledIr, transport: { formId, values, key in
    try await myTrustedClient.submit(formId, values, key)
})
VdsFormView(controller: controller)
```

## Verification (CI)

The sandbox has no Swift toolchain, so this target is verified in CI on macOS:

```bash
cd adapters/swiftui
swift test    # expr conformance (62) + controller tests; builds VdsFormUI too
```

See `.github/workflows/ci.yml` (`swiftui` job, `macos-latest`).
