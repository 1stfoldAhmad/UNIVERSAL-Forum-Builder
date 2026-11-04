# @vds-form/compose — native Jetpack Compose renderer (Kotlin)

A faithful Kotlin port of the canonical form runtime plus a native Material3
Compose UI, split into two Gradle modules:

- **`core`** (Kotlin/JVM, framework-free):
  - `Expressions.kt` — `vds.expr/1` engine (closed operators, budgets, refs,
    error-as-value). Verified against **all 62 shared conformance cases**.
  - `Validation.kt` — effective state, repeater expansion, validation.
  - `Controller.kt` — headless `FormController` (conditions, formulas, repeaters,
    multi-step, drafts/uploads adapters, trusted transport submit).
  - `Capabilities.kt` — capability manifest.
- **`ui`** (Android library + Compose): `VdsForm` composable rendering every
  supported field type, groups, repeaters, steps, errors, i18n and a11y.

Submission is delegated to an injected **trusted transport**; the client never
executes business operations and never sends authoritative identity.

## Usage

```kotlin
val controller = FormController(
    ir = compiledIr, // from `vds-form compile --json`
    transport = SubmissionTransport { formId, values, key -> myTrustedClient.submit(formId, values, key) },
)
VdsForm(controller = controller)
```

## Verification (CI)

The sandbox has no JDK/Gradle/Android SDK and cannot reach Maven/Google, so this
target is verified in CI (full internet):

```bash
cd adapters/compose
gradle :core:test                 # expr conformance (62) + controller tests
gradle :ui:compileDebugKotlin     # Compose UI compile evidence
```

See `.github/workflows/ci.yml` (`compose` job: JDK 21 + Android SDK + Gradle).
