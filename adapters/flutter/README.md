# @vds-form/flutter — native Flutter renderer (Dart)

A faithful Dart port of the canonical form runtime plus a native Material UI:

- `lib/src/expr.dart` — `vds.expr/1` engine (closed operator set, budgets,
  error-as-value, refs). Verified against **all 62 shared conformance cases**.
- `lib/src/validation.dart` — effective state, repeater expansion, validation.
- `lib/src/controller.dart` — headless `FormController` (conditions, formulas,
  repeaters, multi-step, drafts/uploads via injected adapters). Submission is
  delegated to an injected **trusted transport**; the client never executes
  business operations and never sends authoritative identity.
- `lib/src/widgets.dart` — `VdsForm` Material widget rendering every supported
  field type, groups, repeaters, steps, errors, localization and a11y.
- `lib/src/capabilities.dart` — capability manifest.

## Usage

```dart
final controller = FormController(
  ir: compiledIr, // from `vds-form compile --json`
  transport: (formId, values, key) => myTrustedClient.submit(formId, values, key),
);
VdsForm(controller: controller);
```

## Verification (CI)

The sandbox has no Flutter SDK, so this target is verified in CI:

```bash
cd adapters/flutter
flutter test          # expr conformance (62) + controller + widget tests
```

See `.github/workflows/ci.yml` (`flutter` job, `subosito/flutter-action`).
