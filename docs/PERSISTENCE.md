# Persistence boundaries

Status labels: **verified** = executed evidence; **implemented-not-verified** = code + adapter tests, no native/device evidence; **memory-only** = explicitly non-durable.

## Sensitive values

Registry contracts mark sensitive fields (`sensitive: true`, e.g. `password`). By default the runtime strips these before:
- draft save (`persistence.drafts.includeSensitive` defaults to `false`);
- offline enqueue (`persistence.offline.includeSensitive` defaults to `false`).

Offline payloads are rebuilt from stripped source values so `submission.inputMapping` cannot reintroduce secrets. Opt-in is explicit and documented; prefer re-authentication over durable secret queues. If a server requires a stripped secret, replay fails safely (conflict/server-validation) rather than silently succeeding.

## Draft storage

| Adapter | Package | Durability | Evidence |
|---|---|---|---|
| `MemoryDraftStorage` | `@vds-form/persistence` | **memory-only** | runtime tests |
| `KeyValueDraftStorage` | `@vds-form/persistence` | durable if host store is durable | file-backed restart test |
| `createLocalStorageKeyValueStore` | `@vds-form/persistence` | browser localStorage (page reload durable; **not secure**) | wrapper test; native browser restart not verified |
| `createExpoAsyncStorageKeyValueStore` | `@vds-form/persistence` | host AsyncStorage | wrapper test; device restart not verified |
| `createExpoSecureStoreKeyValueStore` | `@vds-form/persistence` | host SecureStore (prefer for sensitive opt-in) | wrapper test; device restart not verified |
| `SqliteDraftStorage` | `@vds-form/execution-node` | **durable** (node:sqlite, Node ≥ 22.5) | close/reopen test |

## Offline queue

| Adapter | Package | Durability | Evidence |
|---|---|---|---|
| `MemoryOfflineQueue` | `@vds-form/persistence` | **memory-only** | runtime tests |
| `KeyValueOfflineQueue` | `@vds-form/persistence` | durable if host store is durable; per-scope + global indexes | file-backed restart/duplicate/update/remove tests |
| `SqliteOfflineQueue` | `@vds-form/execution-node` | **durable**; partial unique index blocks duplicate active idempotency keys | close/reopen/duplicate tests |

## Trusted-server idempotency

`InMemoryIdempotencyStore` is **memory-only**. `SqliteIdempotencyStore` (Node), `SqliteIdempotencyStore` (Django), and `PdoIdempotencyStore` (Laravel) are durable references. Claims carry leases; expired claims require host reconciliation (transaction/outbox) and are never auto-re-executed. See ADR-0005 addendum.

## TEST adapters are not production storage

`integrations/vds-contracts` ships explicitly named TEST adapters (`TestOperationExecutor`, `TestUploadProvider`, `InMemoryRecordStore`, …). They prove contracts end-to-end but are **not** production VDS Database/API/Storage integrations. Production wiring remains blocked on unavailable upstream VDS builder source.
