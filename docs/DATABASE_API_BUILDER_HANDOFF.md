# Form Builder handoff contract for VDS Database/API Builder

This handoff describes the existing canonical boundary. The Database/API Builder must consume the stable `vds.form` specification and trusted operation contracts; it must not create a database-specific form format or move server security into a renderer.

## Consume

- Canonical versioned JSON form: `format: "vds.form"`, current schema under `specifications/json-schema/`.
- Deterministic compiler output / FormIR and its field, layout, path, visibility and payload semantics.
- Field values and validation issue paths/codes from `@vds-form/types`, `@vds-form/validation` and the shared conformance fixtures.
- Submission requests dispatched through an explicitly registered operation name and typed input contract; see `packages/form-submission`, `integrations/vds-contracts`, and `execution-adapters/node` / Django / Laravel adapters.
- Idempotency key, correlation ID and server-derived trusted identity as explicit transport/context fields. Identity must never be accepted from form JSON/body values.
- Upload values as storage-provider-issued asset references and validated metadata. A host upload provider is responsible for content verification and authorization.

## Provide

1. Host-registered operations with strict input schema, authorization, tenant scoping, field-level read/write policy, validation and safe error responses.
2. A trusted authentication resolver that derives identity from the host session/token middleware and never from the submitted payload.
3. Database/API access as injected operation implementations. The form runtime must not receive database credentials or arbitrary query capabilities.
4. Idempotency persistence with replay/conflict semantics, concurrency protection and expiry/recovery policy.
5. A storage/upload provider issuing stable asset references after server-side content inspection and enforcing size/type/tenant access.
6. Correlation-aware logs that avoid form values, secrets, tokens and sensitive upload metadata.

## Explicit non-contracts

Do not add database CRUD semantics to `vds.form`; do not trust client visibility/required rules as server authorization; do not treat TEST adapters as production; do not add a fake production Database or Auth/RBAC Builder. The standalone Form Builder is usable with host-supplied real API/database operations and auth context. Builder-to-builder production integration is deferred until the corresponding VDS products exist.
