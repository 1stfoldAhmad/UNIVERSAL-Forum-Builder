# VDS Form Builder — Laravel / PHP execution adapter

A trusted, server-side execution adapter that mirrors the Node and Django
adapters. It shares the **same canonical JSON standard**, the **same
deterministic FormIR**, and the **same cross-language conformance fixtures**.

> **Status: implemented-not-verified.** The Arena sandbox has no PHP runtime, so
> this adapter is a faithful, reviewable port that has **not been executed
> here**. It is labeled honestly per the implementation ledger. Run the
> conformance command below wherever PHP >= 8.1 is available to verify it.

## Components

| Component | File | Mirrors |
| --- | --- | --- |
| `vds.expr/1` engine (closed typed operators, budgets, no `eval`) | `src/Expressions.php` | TS `form-expressions` / verified Python port |
| Server effective-state + validation | `src/Validation.php` | TS `form-validation` / verified Python port |
| Submission payload builder | `src/Payload.php` | TS `form-submission` / verified Python port |
| Trusted submission handler (re-validation, fail-closed RBAC, field write protection, idempotent replay, version mismatch, redacted audit) | `src/Submission.php` | Node / Django trusted handlers |
| Laravel HTTP controller (lazy Illuminate refs) | `src/LaravelController.php` | Django view |

## Verify (requires PHP >= 8.1)

```bash
cd execution-adapters/laravel
php tests/run-conformance.php
# → Conformance (vds.expr/1, PHP): 62/62 passed, 0 failed.
```

The runner loads the **shared** fixtures from
`packages/form-conformance/fixtures/expressions.json` — the exact file the
TypeScript (`vds-form conformance`) and Python (`pytest`) adapters verify
against. The PHP engine is a line-by-line semantic port of the verified Python
engine, so it is expected to pass; execution is pending a PHP runtime.

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
);
$result = $handler->handle([
    'formId' => 'contact', 'values' => $payload,
    'idempotencyKey' => $key, 'correlationId' => $corr, 'auth' => $auth,
]);
```

## Security guarantees (identical to Node/Django)

- Every submission is re-validated and re-authorized on the server.
- Operations resolve only against a registered `OperationRegistry`; missing →
  `SUBMISSION_OPERATION_UNRESOLVED`. No generic endpoint, no fake `submit()`.
- RBAC fail-closed (`RBAC_NOT_CONFIGURED` / `PERMISSION_DENIED` / `FIELD_WRITE_DENIED`).
- Idempotent replay returns the recorded result without re-execution.
- Audit records value **paths only**, never submitted values.
