# Independent-audit remediation — 2026-11-04

Base: `main` @ `1fba279e7f1dba56227308fb1838c3ba8a4e75c1` (PR #3 merged).
Branch: `arena/f7c0405f-universal-forum-builder`.
Scope: focused remediation of the independent audit findings. No architectural rewrite, no replacement of canonical `vds.form`, no new platform targets, no package publication.

## Baseline (before code changes)

Recorded at `1fba279`:

| Suite | Result |
|---|---|
| TypeScript (`npx vitest run`) | 254 / 254 (21 files) |
| Typecheck (`npm run typecheck`) | pass |
| Conformance CLI | 87 / 87 |
| Django (`python3 -m pytest -q`) | 51 / 51 |
| Laravel PHP-WASM 8.2 | 190 / 190 (8 suites) |
| React example build | pass (249 modules) |

## Final local verification (after remediation)

| Suite | Result |
|---|---|
| TypeScript (`npx vitest run`) | **283 / 283** (26 files) |
| Typecheck | pass |
| Cross-language conformance | **96 / 96** (87 prior + 9 operation-limit vectors) |
| Django/Python | **55 / 55** |
| Laravel PHP-WASM 8.2 | **212 / 212** (10 suites; +9 operation limits, +13 idempotency recovery) |
| React example build | pass (249 modules) |
| Benchmarks (`npm run bench`) | pass |
| Package build (`npm run build:packages`) | pass (23 publishable workspaces, JS + `.d.ts`) |
| Package pack (`npm run pack:packages`) | pass (tarballs under `.release/`, not published) |
| Fresh external-project smoke (`npm run test:packages`) | **PACKAGE SMOKE PASSED** (core/runtime/trusted Node + React/Vue peer imports) |

CI evidence: see the branch run linked in `docs/FINAL_IMPLEMENTATION_AUDIT.md` (authoritative real-PHP Laravel gate). Local PHP results are PHP-WASM; real PHP 8.2 + Illuminate + PDO SQLite run in CI.

## Findings and dispositions

### Phase 2A — Sensitive persistence
**Finding:** drafts/offline queues could persist registry-sensitive values (passwords/tokens).
**Disposition: fixed.**
- `PersistenceDef.drafts.includeSensitive` and `PersistenceDef.offline.includeSensitive` added; default **false**.
- Runtime strips sensitive field templates before draft save and before offline enqueue. Offline payloads are rebuilt from sensitive-stripped source values so `inputMapping` cannot reintroduce secrets.
- `makeDraftEnvelope` accepts `sensitivePaths`; `sensitiveTemplatePaths` / `stripSensitiveValues` exported.
- Tests: `tests/sensitive-persistence.test.ts` (save/restore, opt-in, retry/replay failure when server requires stripped secret, save/enqueue failure paths).

### Phase 2B — Operation-input resource limits
**Finding:** nested operation inputs/additionalProperties lacked recursive depth/node/size limits and forbidden-name checks at every depth.
**Disposition: fixed.**
- TS/Python/PHP `validateOperationInputs` now enforce identical limits: depth 64, nodes 10000, string 10000, array 1000, object keys 1000; forbidden names rejected at every depth, including `additionalProperties` and untyped array elements.
- Shared adversarial fixture: `packages/form-conformance/fixtures/operation-limits.json` (9 vectors), run by TS conformance, Django pytest, PHP runner.

### Phase 2C — Idempotency recovery
**Finding:** abandoned in-progress claims had no lease/expiry recovery contract.
**Disposition: fixed (safe-by-default).**
- Claims carry `claimedAt` / `leaseExpiresAt`; default lease 5 minutes. Expired claims return `expired`, mapped by trusted handlers to `IDEMPOTENCY_RECOVERY_REQUIRED` (HTTP 409). **No automatic re-execution.**
- Host reconciliation contract documented (`IdempotencyRecoveryContract`): transaction/outbox must prove committed → `complete`, or provably not committed → `release`.
- SQLite/PDO schemas migrated with lease columns; restart tests prove durable claims/replay.
- Tests: Node/Django/PHP recovery suites (concurrent claim, expiry, conflict, restart, replay, handler mapping).

### Phase 3A — Data-source cache
**Finding:** shallow JSON replacer could collide nested/reordered filters.
**Disposition: fixed.** Canonical recursive serializer (`canonicalJson`) used for cache keys. Tests: nested objects/arrays/nulls, reordered keys, changing nested filters, TTL.

### Phase 3B — Vue file picker
**Finding:** Choose file button did not open the hidden input.
**Disposition: fixed.** Real input ref; button clicks it; input resets after selection; picker vs drag-drop source distinguished. Test exercises button → input → upload → reset. `filePicker: true` is now backed by a passing interaction test.

### Phase 3C — Expo uploads
**Finding:** only first selected document processed; partial failures could lose successes; camera capability not implemented.
**Disposition: fixed.** All selected documents processed when multiple; existing assets preserved; partial failures keep successful uploads and surface errors; camera button implemented when `captureCamera` injected. Tests with injected adapters cover multi-upload, partial failure, preservation, camera, capability honesty. Expo `dragDrop` remains **false**.

### Phase 4 — Production persistence boundaries
**Finding:** memory-only persistence could be mistaken for durable production storage.
**Disposition: implemented + documented.**
- Memory adapters remain explicitly non-durable.
- Durable references: Node `SqliteDraftStorage` / `SqliteOfflineQueue` (node:sqlite, Node ≥ 22.5) verified across close/reopen.
- Browser/Expo: `KeyValueDraftStorage` / `KeyValueOfflineQueue` over host storage; wrappers for localStorage, Expo AsyncStorage, Expo SecureStore. File-backed restart tests prove adapter durability; **native device restart remains unverified** (no device).
- See `docs/PERSISTENCE.md`.

### Phase 5 — Packaging
**Finding:** source-only exports, no real build/tarball verification.
**Disposition: implemented.**
- `scripts/build-packages.mjs` emits ESM JS + declarations (Node ESM extensions/JSON import attributes fixed up); `scripts/pack-packages.mjs` stages dist-only tarballs with pinned internal versions; `scripts/package-smoke.mjs` installs tarballs into a fresh external project and exercises compile → runtime → trusted Node adapter, plus React/Vue peer imports.
- Peer dependencies verified not duplicated as direct dependencies. CI runs build/pack/smoke.
- Node adapter SQLite minimum documented: Node ≥ 22.5 for `node:sqlite`; in-memory store works on Node ≥ 20.
- **No publishing performed.** `integrations/vds-logic` excluded from packing (vendored `file:` dependency).

### Phase 6 — Plugin/MCP correctness
**Finding:** no renderer registration contract for custom plugin field types; MCP migration malformed input could throw.
**Disposition: fixed.**
- `RendererComponentRegistry` + `PluginRegistrations.rendererComponents`; manifest name `${target}:${fieldType}`; fail-closed trust unchanged (`sandboxed`/`untrusted` rejected); capability gates, duplicate/undeclared/wrong-target rejection, rollback/revocation tested.
- MCP `migrate_form` returns structured `MCP_INPUT_INVALID` diagnostics for malformed JSON/non-object input; permission-denied tested.

### Phase 7 — Docs/audit
**Disposition: updated.** Ledger, final audit, ADR addenda, `docs/PERSISTENCE.md`, `docs/RENDERER_CAPABILITIES.md`, `docs/INTEGRATION_BOUNDARIES.md`.

## Remaining blockers / unverified items

| Item | Status |
|---|---|
| Production VDS Database/API/Storage/Notification/Plugin-Host wiring | **Blocked** on unavailable upstream VDS source; only contracts + named TEST adapters |
| Flutter / Compose / SwiftUI | **Not started / blocked** (no toolchains; out of scope) |
| Expo on-device picker/camera/storage restart | **Implemented-not-verified** (RN-web/jsdom + injected adapters only) |
| Browser/Expo native storage restart | **Implemented-not-verified** on device; adapter restart verified with file-backed store; Node SQLite verified |
| Laravel real PHP 8.2 + Illuminate | CI gate (local PHP-WASM only) |
| Package publication | **Not authorized / not performed** |
| Expired idempotency claims | Require host transaction/outbox reconciliation; no unsafe auto-retry |
