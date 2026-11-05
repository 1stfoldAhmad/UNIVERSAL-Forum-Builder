# Security remediation — Phase 1 (2026 cycle)

Branch: `arena/ba37c6a7-universal-forum-builder` · Baseline: `ab85ea7` ·
Baseline evidence: `docs/audit/BASELINE_2026.md`.

Phase 1 was completed **before** any new platform work, as required.

---

## S-1 (P0) — Django CSRF boundary was exempted unconditionally

### Finding
`execution-adapters/django/vds_form/django_view.py` wrapped the submission view in
`@csrf_exempt` while simultaneously deriving identity from `request.user`. In any
cookie/session-authenticated deployment this allowed a **cross-site forged
submission to execute a trusted operation as the victim**.

The same defect existed in the server-rendered form view
`adapters/django/vds_form_renderer/views.py`: it *rendered* a
`csrfmiddlewaretoken` hidden input but never verified it, which is worse than not
rendering one because it looks protected.

The previous tests could not detect this: they called the view directly through
`RequestFactory`, which bypasses middleware entirely.

### Fix
Both views are now **CSRF-protected by default** using `csrf_protect`, which
enforces the check even if the host forgot to install `CsrfViewMiddleware`
(defense in depth, not a substitute for it).

Token-only hosts may opt out **explicitly**:

```python
create_submission_view(handler, auth_resolver=verified_bearer_resolver,
                       csrf_exempt_token_auth=True)
```

Conditions, enforced in code:

1. `auth_resolver` is **required**; omitting it raises `ValueError` at wiring time
   (an endpoint with CSRF off and no identity source is a misconfiguration).
2. On that route identity comes **only** from the resolver. `request.user` is
   never consulted, so a session cookie can never grant authority there.
3. A request that presents the Django session cookie but yields no token
   principal is refused with **403 `CSRF_SESSION_AUTH_FORBIDDEN`** instead of
   being silently downgraded to anonymous.

Unchanged guarantees: body-supplied `auth` is still rejected with
`AUTH_IN_BODY_FORBIDDEN`; identity is server-derived; RBAC remains fail-closed.

### Verification (real middleware)
New harness: `tests/conftest.py` configures a real
Session → Authentication → `CsrfViewMiddleware` stack, `tests/django_urls.py` is a
real URLconf, and `tests/test_django_csrf.py` drives
`django.test.Client(enforce_csrf_checks=True)`.

| Required scenario | Test | Result |
|---|---|---|
| Session auth + valid CSRF token | `test_session_auth_with_valid_csrf_token_succeeds` | pass |
| Session auth, no CSRF token | `test_session_auth_without_csrf_token_is_rejected` | pass (403, operation never runs) |
| Invalid CSRF token | `test_session_auth_with_invalid_csrf_token_is_rejected` | pass (403, operation never runs) |
| Valid token auth | `test_token_auth_request_succeeds_without_csrf` | pass |
| Forged body auth | `test_forged_body_auth_is_rejected_on_protected_route` / `..._on_token_route` | pass (400) |
| Anonymous public form | `test_anonymous_public_form_succeeds_with_csrf_token` | pass |
| Anonymous protected form | `test_anonymous_protected_form_is_denied` | pass (403 `PERMISSION_DENIED`) |
| Missing permissions | `test_session_user_without_permission_is_denied`, `test_token_without_permission_is_denied` | pass |
| Tenant isolation | `test_idempotency_key_is_tenant_scoped` | pass (same key, different tenant → new execution, no cross-tenant record) |

Additional hardening tests: CSRF applies to anonymous POSTs too; `allow_anonymous=False`
→ 401; exemption without resolver → `ValueError`; session cookie cannot ride the
exempt route; protection holds even without CSRF middleware; unknown bearer token
is anonymous and denied; same-tenant replay stays idempotent.

The pre-existing view tests were **not deleted or weakened**. Their assertions are
unchanged; only the transport was updated to present a valid CSRF token (public
`get_token()` API, cookie + header, portable across Django versions). The renderer
suite additionally gained a negative test proving an untokened POST is rejected
and the trusted operation never runs.

---

## S-2 (P1) — Renderer uploads discarded successful assets on partial failure

### Finding
React, Vue and Angular accumulated uploaded refs in a local array and committed
them to the controller **only after the whole batch**. One rejected file therefore
threw into `catch` and **every already-uploaded asset in that batch was lost**.
All three also hard-coded `source: 'drag-drop'` even for picker interactions, had
no cancellation, no de-duplication, and no client-side MIME/size enforcement.
Expo collected per-file failures but still committed only at the end.

### Fix
One shared, headless implementation now owns the semantics:
`packages/form-runtime/src/uploads.ts` → `uploadAssetBatch()`, exported from
`@vds-form/runtime` and used by **all four** renderers. Rules:

1. Commit after **every** success (partial success survives later failures).
2. Append preserves existing assets on multi-value fields.
3. Per-file failures are reported; the batch continues.
4. MIME/size checked **before** the provider, using the same codes as server
   validation: `ASSET_TYPE_REJECTED`, `ASSET_TOO_LARGE`, `MULTIPLE_NOT_ALLOWED`.
5. Identical assets (name + size) are de-duplicated, not re-uploaded.
6. Cooperative cancellation keeps committed assets and never commits an
   in-flight result from an aborted batch.
7. Real `source` attribution (`picker` / `drag-drop` / `camera`), with native
   `id`/`localUri` preserved for Expo.

Renderers additionally: ignore re-entrant interactions while a batch is in flight,
abort in-flight uploads on unmount/destroy, and (React) expose a Cancel control
plus per-file error text including the error code.

### Verification
| Suite | Command | Result |
|---|---|---|
| Shared semantics (headless) | `npx vitest run --project core packages/form-runtime/tests/uploads.test.ts` | **14 pass** |
| React uploads | `npx vitest run --project web adapters/react` | **24 pass** (8 existing + 16 new) |
| Vue parity | `npx vitest run --project web adapters/vue` | **10 pass** (8 existing + 2 new) |
| Angular parity | `npx vitest run --project angular` | **10 pass** (8 existing + 2 new) |
| Expo | `npx vitest run --project native` | **12 pass** (existing partial-failure tests now exercise the shared path) |

Required scenarios all covered: single success, multiple success, first/middle/last
failure, partial success with multiple failures, picker source, drag-and-drop
source, cancellation, repeated interaction, plus MIME/size rejection, extra-file
reporting, missing provider and unmount abort.

---

## S-3 — Security regression review

Re-run unchanged (no assertion was relaxed):

| Area | Evidence |
|---|---|
| Server-derived identity, operation binding, allowlist | `tests/security.test.ts`, PHP `run-security.php` (34), Python `test_security.py` |
| Field read/write authorization, hidden-field stripping | `form-validation` read policy; PHP `run-security-policy.php` (14) |
| Unknown property rejection / operation input limits | PHP `run-operation-limits.php` (9); shared `operation-limits.json` |
| Prototype-pollution resistance | shared `security-paths.json` vectors in TS/Python/PHP |
| Idempotency, replay authorization, recovery | PHP `run-idempotency-parity.php` (7), `run-idempotency-recovery.php` (13); Node durable tests |
| Sensitive persistence / redaction | `tests/sensitive-persistence.test.ts` |
| Plugin trust / MCP grants | `form-plugin-sdk` tests |
| **CSRF (new)** | `test_django_csrf.py` (19) through real middleware |

No security property is asserted on client-side behaviour alone: the upload
constraints added in S-2 are a UX mirror of the server checks, which remain
authoritative and are still enforced by the trusted adapters.

---

## Phase 1 totals (actual)

| Suite | Before | After |
|---|---|---|
| TypeScript (all projects) | 297 / 28 files | **331 / 30 files** |
| Django execution adapter | 55 | **74** |
| Django renderer | 10 | **12** |
| Laravel/PHP (WASM 8.2) | 212 | **212** (unchanged, all pass) |
| Cross-language conformance | 96 | **96** |
| `tsc --noEmit` | clean | clean |
| build / pack / package smoke | pass | pass |

## Still open (not claimed as fixed)

- Production VDS Database/Auth/RBAC/Storage providers: **deferred**; TEST adapters only.
- Expired idempotency claims still require host transaction/outbox reconciliation.
- Laravel/Node CSRF-equivalent review for their own HTTP surfaces is scheduled in
  Phases 6 and 8 (Laravel uses framework middleware; Node's handler is
  framework-independent and receives a server-derived principal).
- Physical-device verification: **pending**.
