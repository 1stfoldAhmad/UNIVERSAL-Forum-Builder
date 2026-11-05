# Platform support matrix

This matrix is a conservative audit snapshot. Capability manifests exist per target, but their current shapes are not sufficiently uniform to generate a trustworthy machine-derived matrix. Do not interpret a declared field-type list as proof of usable behavior. CI evidence is only the commands listed in the workflow; this sandbox verified only the rows explicitly shown below.

| Target | Field/UI support status | Upload/camera/signature/barcode | Layout, repeaters, steps | Draft/offline | Verification in this checkout |
|---|---|---|---|---|---|
| React | Supported for tested web controls; remaining field-by-field parity not independently audited | Shared upload implementation wired for browser file input/drop; camera/signature not claimed | Existing tests cover invoice repeater; full layout parity unverified | injected persistence contracts; renderer persistence parity unverified | Vitest web tests pass in full suite |
| Vue | Supported for tested web controls; remaining parity unverified | shared upload wired; no native camera claim | Tested repeater; full layout parity unverified | unverified | Vitest web tests pass |
| Angular | Supported for tested controls; remaining parity unverified | shared upload wired; camera/signature not claimed | full layout parity unverified | unverified | Vitest Angular tests pass |
| Next.js App Router example | Example integration, not a separate renderer; App Router Server/Client boundary implemented | Uses registered trusted Node handler route with demo-only TEST operation | n/a | n/a | Production build and local SSR/API smoke pass; Playwright hydration E2E pending CI |
| Expo | Partial: automated RN-web renderer tests only | host-injected native picker/camera interfaces; physical device behavior unverified; drag-drop unsupported | automated subset only | durable/device behavior unverified | 12 automated tests pass; no device tests |
| Flutter | Partial; manifest labels incomplete field behavior partial and signature unsupported | file/image picker unsupported; upload requires host adapter; camera unsupported | full layout parity not verified | draft/offline unsupported | CI format/analyze/widget result pending on latest commit |
| Compose | Partial; manifest labels incomplete fields partial and file/image/signature unsupported | file/image picker and camera unsupported; upload requires host adapter | full layout parity not verified | draft/offline unsupported | core tests and UI compile passed on prior CI commit; new capability/concurrency assertions pending |
| SwiftUI | Partial; manifest labels incomplete fields partial and file/image/signature unsupported | file/image picker and camera unsupported; upload requires host adapter | full layout parity not verified | draft/offline unsupported | test/build result pending (runner queued) |
| Django SSR | Server-rendered output; not a native interactive renderer | provider-dependent | limited SSR contract; full layout parity unverified | host-dependent | 12 renderer tests pass |
| Laravel | Framework adapter, not a standalone native renderer | provider-dependent | not a UI renderer | host-dependent | Laravel 13 full HTTP lifecycle not proven by this run |

## Runtime/framework and package evidence

- Node in this workspace: Node 22.22.3 typecheck, 346 Vitest tests, 96 shared conformance cases and npm build/pack/fresh-consumer smoke pass. The root engine floor is `>=22.5`; Node 22/24/26 matrix passed on commit `d45ed660`, but latest-head reruns remain pending.
- Django: local Python 3.11 / Django 5.2.19 runs pass: execution 75 tests, SSR 12 tests; both wheels install in a fresh consumer. All nine requested Python/Django matrix jobs passed on commit `d45ed660`; latest-head reruns remain pending.
- Laravel 13: real PHP 8.3 / Laravel 13 CI integration check passed on commit `d45ed660`, but it still does not exercise complete Laravel route+middleware+session/CSRF lifecycle. Treat as partial.
- Flutter / Compose / SwiftUI: no toolchain results in this local run.
- Physical iOS/Android devices, picker/camera permissions, lifecycle cancellation, offline transitions and durable restart: pending.
- Packaging: npm packs and fresh external npm consumer smoke verified; both Django wheels were installed into a fresh consumer. Composer consumer, Dart dry-run, Gradle/Maven and Swift package release checks remain unverified.

Capability classifications in this matrix are intentionally cautious and supersede optimistic claims in older historical audits pending a manifest normalization and functional test audit.
