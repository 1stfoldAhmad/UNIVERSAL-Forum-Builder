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

- Node in this workspace: installed packages, TypeScript typecheck, 332 Vitest tests, 96 shared conformance cases and npm build/pack/fresh-consumer smoke all pass. The root engine floor is now `>=22.5`; workflow matrix declares Node 22/24/26, but remote job outcomes are not verified in this local run.
- Django: the local run used Python 3.11 and Django 5.2.19; execution adapter 74 tests and SSR adapter 12 tests pass. This does not verify the requested full Python/Django matrix.
- Laravel 13: not verified in this sandbox; existing workflow evidence is not a complete replacement for actual full lifecycle acceptance.
- Flutter / Compose / SwiftUI: no toolchain results in this local run.
- Physical iOS/Android devices, picker/camera permissions, lifecycle cancellation, offline transitions and durable restart: pending.
- Packaging: npm packs and fresh external npm consumer smoke verified. Python wheel, Composer consumer, Dart, Gradle/Maven and Swift package release checks were not performed in this run.

Capability classifications in this matrix are intentionally cautious and supersede optimistic claims in older historical audits pending a manifest normalization and functional test audit.
