# ADR-0006 — Verification policy & environment-blocked targets

Status: accepted · 2026-11-04

## Decision
- Status labels follow the specification exactly: verified / implemented-not-verified /
  partial / unsupported / blocked / not-started. **Verified requires executed test evidence**
  recorded in `docs/IMPLEMENTATION_STATUS.md` with the exact command.
- This sandbox has no Dart/Flutter/Kotlin/Gradle/Swift toolchains and no access to their
  distribution hosts. Flutter, Jetpack Compose and SwiftUI renderers are therefore
  **blocked — not started**, with contracts + conformance fixtures ready for them.
  We deliberately do **not** create placeholder native packages.
- PHP/Composer are absent and packagist is unreachable. The Laravel adapter is implemented
  as a framework-free PHP core + Laravel service provider; we attempt to obtain a static
  PHP binary from GitHub releases to execute shared fixtures. If unavailable, it is
  reported **implemented, not verified** — never "verified".
- Expo adapter verification uses the reference library's CI technique (vitest + jsdom +
  react-native-web). Real-device/Emulator verification is documented as an outstanding
  release task, not claimed here.

## Consequences
The final audit can never report 100% completion while any target lacks evidence.


## Addendum — independent-audit remediation (2026-11-04)

- Verified local totals: TS 283/283, conformance 96/96, Django 55/55, PHP-WASM 212/212, React build, package smoke.
- Expo drag-and-drop is not claimed; camera/filePicker capabilities are conditional on injected adapters and tested behavior.
- Packaging emits JS + declarations and is tested from packed tarballs in a fresh external project; no publication without authorization.
- Native Expo/device storage restart and production VDS builder wiring remain unverified/blocked, not claimed.
