# Renderer capability honesty

Capabilities are advertised only when backed by implementation + tests. `trust: 'sandboxed'` is **not** isolation; no sandbox exists.

| Feature | React | Vue | Angular | Expo |
|---|---|---|---|---|
| dragDrop | true | true | true | **false** (no native drag-drop claim) |
| filePicker | true | true (button → hidden input tested) | true | only when host injects `pickImage`/`pickDocument` |
| camera | false | false | false | only when host injects `captureCamera` (tested via injected adapter) |
| offlineQueue / draftPersistence | true | true | true | true (host storage adapter required for durability) |
| multiStep / repeaters | true | true | true | true |
| richText / signature | false | false | false | false |

## Expo uploads
- Multiple documents: all selected assets processed when `validation.multiple` is true.
- Existing uploaded assets are preserved when adding more.
- Partial failures keep successful uploads and surface a structured error message.
- Camera is implemented as a host-injected adapter; without it the capability is false and the UI shows unsupported state.
- Verification is RN-web/jsdom with injected adapters; **on-device verification is not claimed**.

## Custom plugin field renderers
`RendererComponentRegistry` (plugin SDK) registers opaque platform components keyed by `${target}:${fieldType}`. Registration does not automatically advertise capabilities; compiler negotiation still uses the renderer capability manifest. Plugin trust remains fail-closed: `sandboxed`/`untrusted` manifests are rejected until a real isolation adapter exists.

## New platform renderers (ADR-0007)

Six renderers were added under `adapters/{node,django,laravel,flutter,compose,swiftui}`.
All operate on the compiled `FormIR` and submit through trusted execution adapters
(server family) or an injected trusted transport (native family). `signature` and
`richText` are **not** supported and are not advertised.

| Capability | Node/TS | Django | Laravel 13 | Flutter | Compose | SwiftUI |
|---|---|---|---|---|---|---|
| Field types | 30/31 (no signature) | 30/31 | 30/31 | 30/31 | 30/31 | 30/31 |
| groups / repeaters / multiStep | true | true | true | true | true | true |
| conditions + formulas | true | true | true | true | true | true |
| validation / error display | true | true | true | true | true | true |
| localization + a11y | true | true | true | true | true | true |
| no-JS fallback | true (urlencoded POST) | true | true | n/a (native) | n/a | n/a |
| hydration / live runtime | shared client | shared client | shared client | native controller | native controller | native controller |
| uploads / drafts / offline | injected adapters | injected adapters | injected adapters | injected adapters | injected adapters | injected adapters |
| trusted submission | TrustedSubmissionHandler | TrustedSubmissionHandler | TrustedSubmissionHandler | injected transport | injected transport | injected transport |
| filePicker | true | true | true | true | true | true |
| camera | false | false | false | host adapter | host adapter | host adapter |
| dragDrop | true | true | true | false | false | false |

### Verification status

| Target | Local evidence (this sandbox) | CI gate (real toolchain) |
|---|---|---|
| Node/TS | Vitest core (47) + jsdom hydration (4) | `typescript` job (`vitest run`) |
| Django | pytest renderer (10) + execution (55) | `django` job |
| Laravel | PHP-WASM 8.2 renderer (38) + execution suites | `laravel` job (PHP 8.2) + `laravel13` job (PHP 8.3 + Laravel ^13) |
| Flutter | not runnable (no SDK) | `flutter` job: `flutter test` (62 conformance + controller + widget) |
| Compose | not runnable (no JVM/Gradle) | `compose` job: `:core:test` (62 conformance + controller) + `:ui:compileDebugKotlin` |
| SwiftUI | not runnable (no Swift) | `swiftui` job (macOS): `swift test` (62 conformance + controller; builds UI) |

The native ports are verified against the **same 62 shared expression conformance
cases** and shared compiled IR fixtures. No native device/on-device claim is made;
Flutter/Compose/SwiftUI evidence is CI unit/widget/compile evidence only.
