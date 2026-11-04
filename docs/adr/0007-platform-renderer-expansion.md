# ADR-0007: Platform renderer expansion (Node, Django, Laravel, Flutter, Compose, SwiftUI)

- Status: accepted
- Date: 2026-11-05
- Supersedes the "no new platform renderers" constraint of the independent-audit
  remediation (that constraint applied only to that finished task).

## Context

The product had web renderers (React, Vue, Angular) and one native renderer
(Expo), plus trusted **execution** adapters (Node, Django, Laravel) that submit
forms but did not render them. The user asked for real, working renderers for six
additional targets: Flutter (Dart), Compose (Kotlin), SwiftUI (Swift), Laravel 13,
Python Django, and Node.js + TypeScript — the latter three with "full support".

## Decision

Add six renderers under `adapters/{node,django,laravel,flutter,compose,swiftui}`
without rewriting the existing architecture. Two families share one canonical
contract (the compiled `FormIR` produced by the TS compiler):

### 1. Server-rendered family — Node, Django, Laravel

These produce the **same server-rendered HTML contract** (stable `data-*`
attributes, dot-path input names, embedded IR/values JSON). A single hydration
client (`@vds-form/node/client`) enhances all three with the full headless
runtime (conditions, formulas, repeaters, multi-step, uploads/drafts/offline via
injected adapters). They work with **no JavaScript** (plain urlencoded POST) and
submit through the existing **trusted execution adapters** with a server-derived
principal. "Full support" = all 31 canonical field types except `signature`
(declared in each capability manifest), groups, repeaters, multi-step, conditions
+ formulas, validation/error display, localization + a11y, uploads/drafts/offline
via injected platform adapters.

- Node: `adapters/node` (SSR + Fetch/Node/Express handler + hydration client).
- Django: `adapters/django` (framework-free renderer + `create_form_view` +
  template tag), reusing the `vds_form` execution port.
- Laravel: `adapters/laravel` (framework-free `Renderer` + `RenderController` +
  ServiceProvider + Blade directive), reusing the `VdsForm` execution port.

### 2. Native family — Flutter, Compose, SwiftUI

Each is a faithful port of the canonical runtime (the `vds.expr/1` engine,
effective state + validation, a headless controller) plus a native UI. They
operate on the compiled `FormIR` and submit through an **injected trusted
transport**; the client never executes business operations and never sends
authoritative identity. Uploads/drafts/offline are injected platform adapters.

- Flutter: `adapters/flutter` (Dart core + Material `VdsForm`).
- Compose: `adapters/compose` (`core` Kotlin/JVM + `ui` Android/Compose Material3).
- SwiftUI: `adapters/swiftui` (`VdsForm` Foundation core + `VdsFormUI` SwiftUI).

## Verification strategy (honesty)

The sandbox has Node/Python/PHP-WASM but **no** Flutter/JVM/Gradle/Android/Swift
toolchains and cannot reach Maven/Google/Apple CDNs. Therefore:

- **Local (executed here):** Node renderer (Vitest core + jsdom hydration),
  Django renderer (pytest), Laravel renderer core (PHP-WASM 8.2). Existing
  TS/Python/PHP suites remain green.
- **CI-only (real toolchains):** Flutter (`flutter test`), Compose
  (`gradle :core:test` + `:ui:compileDebugKotlin`, JDK 21 + Android SDK),
  SwiftUI (`swift test`, macOS), and **real Laravel 13** (`php tests/run-laravel13.php`
  on PHP 8.3 + `laravel/framework ^13`, booting a real Illuminate container and
  parsing a real `Illuminate\Http\Request`).

All native ports are gated on the **same 62 shared expression conformance cases**
(`packages/form-conformance/fixtures/expressions.json`) plus controller tests
against shared compiled IR fixtures. No target is claimed verified without
executed evidence (ADR-0006).

## Consequences

- One HTML contract + one hydration client avoids three divergent server UIs.
- Native ports duplicate the expression/validation semantics by design; the
  shared conformance fixtures are the cross-language guardrail.
- `signature` and `richText` remain unsupported on the new targets and are not
  advertised. Production VDS Database/API/Storage wiring remains blocked behind
  contracts + TEST adapters (unchanged).
