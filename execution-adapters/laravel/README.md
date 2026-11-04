# VDS Form Builder — Laravel / PHP execution adapter

A trusted, server-side execution adapter that mirrors the Node and Django
adapters. It shares the **same canonical JSON standard**, the **same
deterministic FormIR**, and the **same cross-language conformance fixtures**.

> **Status: verified.** The full suite runs in CI on a real PHP 8.2 toolchain
> (expression + form conformance, idempotency parity, trusted handler, controller
> auth boundary, and adversarial security). It is also verified locally under
> PHP-WASM — see `tests/run-wasm.mjs`.

## Components

| Component | File | Mirrors |
| --- | --- | --- |
| `vds.expr/1` engine (closed typed operators, budgets, no `eval`) | `src/Expressions.php` | TS `form-expressions` / verified Python port |
| Server effective-state + validation | `src/Validation.php` | TS `form-validation` / verified Python port |
| Submission payload builder | `src/Payload.php` | TS `form-submission` / verified Python port |
| Scoped, atomic, fingerprinted idempotency | `src/Idempotency.php` | Node / Python idempotency |
| Trusted submission handler (re-validation, fail-closed RBAC, field write protection, operation binding, idempotent replay, version mismatch, redacted audit) | `src/Submission.php` | Node / Django trusted handlers |
| Laravel HTTP controller (server-derived auth, injectable responder) | `src/LaravelController.php` | Django view |

## Security boundary (audit P0/P1)

1. **Identity is server-derived, never client-supplied.** `handle($request,
   $auth)` takes the principal as a **separate, trusted second argument**. The
   controller derives `$auth` from `$request->user()` or a host `authResolver`
   that reads validated token claims — **never** from the body. Any body that
   contains an `auth` key is rejected with `400 AUTH_IN_BODY_FORBIDDEN`.
2. **The operation is bound to the compiled FormIR.** A client `operationRef`
   that differs from `ir.submission.operationRef` is rejected
   (`OPERATION_OVERRIDE_FORBIDDEN`); an optional `allowedOperations` allowlist
   further restricts it (`OPERATION_NOT_ALLOWED`).
3. **Idempotency is safe by construction.** Checked only *after* auth/authz/
   version; keys scoped by `tenant + user + form + operation`; canonical SHA-256
   payload fingerprint (same key + different payload → `IDEMPOTENCY_KEY_CONFLICT`);
   atomic claims via a UNIQUE primary key in `PdoIdempotencyStore`.

## Cross-language contract

Compile once with the TS compiler and register the IR with the handler:

```bash
npx tsx tools/cli/src/bin.ts compile examples/forms/contact.vds.json --json > contact.ir.json
```

```php
$ops = new \VdsForm\OperationRegistry();
$ops->register('database:contact.create', fn($payload, $ctx) => $repo->create($payload));
$handler = new \VdsForm\TrustedSubmissionHandler(
    ['contact' => json_decode(file_get_contents('contact.ir.json'), true)],
    $ops,
    new \VdsForm\SimpleRbacEvaluator(),
    null,                                   // audit sink (optional)
    \VdsForm\PdoIdempotencyStore::sqlite('/path/idem.sqlite'), // durable store
);

// $auth is the SERVER-DERIVED principal — never from the request body.
$result = $handler->handle(
    ['formId' => 'contact', 'values' => $payload, 'idempotencyKey' => $key, 'correlationId' => $corr],
    $auth
);
```

### Laravel HTTP wiring

```php
Route::post('/api/forms/submit', [\VdsForm\LaravelController::class, 'submit'])
     ->defaults('handler', $handler);

// Token-based hosts: inject a resolver that reads VERIFIED claims.
$controller = new \VdsForm\LaravelController(
    null,                                   // default responder (response()->json)
    fn($request) => $request->user() ? \VdsForm\auth_context_from_claims($request->user()->claims) : null
);
```

## Idempotency storage

| Store | Durability | Use |
| --- | --- | --- |
| `InMemoryIdempotencyStore` (default) | **Not** durable; single process | dev / tests |
| `PdoIdempotencyStore` (SQLite/MySQL/Postgres) | Durable; atomic via UNIQUE primary key | **production** |

Scoped keys and fingerprints are byte-identical across Node, Python, and PHP
(verified against `packages/form-conformance/fixtures/idempotency.json`).

> **PHP note:** `json_decode(..., true)` cannot distinguish an empty JSON object
> `{}` from an empty array `[]`; canonicalization treats an empty PHP array as
> `[]`. Fingerprints only need to be consistent per backend, and the shared
> parity vectors avoid the ambiguous empty-object case.

## Verify (requires PHP >= 8.1)

```bash
cd execution-adapters/laravel
composer install            # pulls illuminate/http for the real-Request check
composer test               # runs every suite below
```

| Suite | Runner | Checks |
| --- | --- | --- |
| Expression conformance | `tests/run-conformance.php` | 62 shared `vds.expr/1` fixtures |
| Form conformance | `tests/run-form-conformance.php` | shared validation + payload cases via compiled IR |
| Idempotency parity | `tests/run-idempotency-parity.php` | cross-language canonical/fingerprint/key vectors |
| Trusted handler | `tests/run-submission.php` | re-validation, RBAC, replay, version, audit, mapping |
| Controller auth boundary | `tests/run-controller.php` | body-auth rejection, anonymous denial, resolver, real Illuminate request |
| Adversarial security | `tests/run-security.php` | operation override/allowlist, isolation, conflict, authz-before-replay, durable restart, forged auth |

The runners are framework-free (no PHPUnit required). `tests/run-controller.php`
additionally exercises a real `Illuminate\Http\Request` when `illuminate/http`
is installed (it is, in CI).

### Local verification without a native PHP (PHP-WASM)

```bash
npm install --no-save --no-audit --no-fund @php-wasm/node   # GPL-2.0, not committed
node execution-adapters/laravel/tests/run-wasm.mjs
```

`@php-wasm/node` is intentionally **not** a committed dependency; CI uses a real
PHP toolchain instead.

## Security guarantees (identical to Node/Django)

- Every submission is re-validated and re-authorized on the server.
- Operations resolve only against a registered `OperationRegistry`; missing →
  `SUBMISSION_OPERATION_UNRESOLVED`. No generic endpoint, no fake `submit()`.
- RBAC fail-closed (`RBAC_NOT_CONFIGURED` / `PERMISSION_DENIED` / `FIELD_WRITE_DENIED`).
- Idempotent replay returns the recorded result without re-execution, scoped per
  principal and bound to the payload fingerprint.
- Audit records value **paths only**, never submitted values.
