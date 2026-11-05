# Platform support matrix

This matrix is a conservative audit snapshot. Capability manifests exist per target, but their current shapes are not sufficiently uniform to generate a trustworthy machine-derived matrix. Do not interpret a declared field-type list as proof of usable behavior. CI evidence is only the commands listed in the workflow; this sandbox verified only the rows explicitly shown below.

| Target | Field/UI support status | Upload/camera/signature/barcode | Layout, repeaters, steps | Draft/offline | Verification in this checkout |
|---|---|---|---|---|---|
| React | Supported for tested web controls; remaining field-by-field parity not independently audited | Shared upload implementation wired for browser file input/drop; camera/signature not claimed | Existing tests cover invoice repeater; full layout parity unverified | injected persistence contracts; renderer persistence parity unverified | Vitest web tests pass in full suite |
| Vue | Supported for tested web controls; remaining parity unverified | shared upload wired; no native camera claim | Tested repeater; full layout parity unverified | unverified | Vitest web tests pass |
| Angular | Supported for tested controls; remaining parity unverified | shared upload wired; camera/signature not claimed | full layout parity unverified | unverified | Vitest Angular tests pass |
| Expo | Partial: automated RN-web renderer tests only | host-injected native picker/camera interfaces; physical device behavior unverified; drag-drop unsupported | automated subset only | durable/device behavior unverified | 12 automated tests pass; no device tests |
| Flutter | Partial / not independently verified here | host adapters and UI wiring require audit; no camera/signature claim | full layout parity not verified | unsupported unless concrete persistence adapter is supplied | no Dart toolchain run in this checkout |
| Compose | Partial / not independently verified here | host adapters and UI wiring require audit; no camera/signature claim | full layout parity not verified | unsupported unless concrete persistence adapter is supplied | no Gradle/Android run in this checkout |
| SwiftUI | Partial / not independently verified here | host adapters and UI wiring require audit; no camera/signature claim | full layout parity not verified | unsupported unless concrete persistence adapter is supplied | no Swift toolchain run in this checkout |
| Django SSR | Server-rendered output; not a native interactive renderer | provider-dependent | limited SSR contract; full layout parity unverified | host-dependent | 12 renderer tests pass |
| Laravel | Framework adapter, not a standalone native renderer | provider-dependent | not a UI renderer | host-dependent | Laravel 13 full HTTP lifecycle not proven by this run |

## Runtime/framework and package evidence

- Node in this workspace: installed packages, TypeScript typecheck, 332 Vitest tests, 96 shared conformance cases and npm build/pack/fresh-consumer smoke all pass. The root engine currently still advertises `>=20`; requested Node 22/24/26 matrix is not verified here.
- Django: the local run used Python 3.11 and Django 5.2.19; execution adapter 74 tests and SSR adapter 12 tests pass. This does not verify the requested full Python/Django matrix.
- Laravel 13: not verified in this sandbox; existing workflow evidence is not a complete replacement for actual full lifecycle acceptance.
- Flutter / Compose / SwiftUI: no toolchain results in this local run.
- Physical iOS/Android devices, picker/camera permissions, lifecycle cancellation, offline transitions and durable restart: pending.
- Packaging: npm packs and fresh external npm consumer smoke verified. Python wheel, Composer consumer, Dart, Gradle/Maven and Swift package release checks were not performed in this run.

Capability classifications in this matrix are intentionally cautious and supersede optimistic claims in older historical audits pending a manifest normalization and functional test audit.
