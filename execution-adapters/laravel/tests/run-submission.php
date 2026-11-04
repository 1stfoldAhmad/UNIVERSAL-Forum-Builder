<?php
/**
 * Trusted submission handler tests (PHP) — mirrors the Node and Django adapters:
 * server re-validation, fail-closed RBAC, idempotent replay, version mismatch,
 * unresolved operations, redacted audit, and reversed input mapping. Auth is the
 * trusted second argument to handle() (never inside the request).
 *
 * Run: php tests/run-submission.php   (requires PHP >= 8.1)
 */
declare(strict_types=1);

require __DIR__ . '/lib.php';
require_once __DIR__ . '/../src/Expressions.php';
require_once __DIR__ . '/../src/Validation.php';
require_once __DIR__ . '/../src/Idempotency.php';
require_once __DIR__ . '/../src/Submission.php';

use VdsForm\TrustedSubmissionHandler;
use VdsForm\OperationRegistry;
use VdsForm\SimpleRbacEvaluator;

$r = new Runner();

// Successful submission persists via the registered operation.
$saved = [];
$ops = new OperationRegistry();
$ops->register('test:contact.create', function ($p, $c) use (&$saved) { $saved = $p; return array_merge(['id' => 'rec-1'], $p); });
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], $ops);
$res = $h->handle(contact_request());
$r->eq('successful submission status', 'succeeded', $res['status']);
$r->eq('operation received payload', 'ada@example.com', $saved['email'] ?? null);
$r->eq('result carries record id', 'rec-1', $res['data']['id'] ?? null);

// Server re-validates even if the client sent an invalid payload.
$ops = new OperationRegistry();
$ops->register('test:contact.create', fn($p, $c) => ['id' => 'x']);
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], $ops);
$res = $h->handle(contact_request(['values' => ['name' => 'A', 'email' => 'bad', 'message' => 'short']]));
$r->eq('invalid payload rejected', 'server-validation-failed', $res['status']);
$codes = array_map(fn($i) => $i['code'], $res['issues'] ?? []);
$r->check('FORMAT_INVALID present', in_array('FORMAT_INVALID', $codes, true), json_encode($codes));
$r->check('all issues server-sourced', !array_filter($res['issues'] ?? [], fn($i) => ($i['source'] ?? '') !== 'server'));

// Missing operation → unresolved.
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], new OperationRegistry());
$res = $h->handle(contact_request());
$r->eq('missing operation status', 'config-error', $res['status']);
$r->eq('missing operation code', 'SUBMISSION_OPERATION_UNRESOLVED', $res['code'] ?? null);

// Unregistered form.
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], new OperationRegistry());
$res = $h->handle(contact_request(['formId' => 'nope']));
$r->eq('unregistered form', 'config-error', $res['status']);

// Idempotent replay does not re-execute.
$calls = 0;
$ops = new OperationRegistry();
$ops->register('test:contact.create', function ($p, $c) use (&$calls) { $calls++; return ['id' => "rec-$calls"]; });
$audit = [];
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], $ops, null, function ($e) use (&$audit) { $audit[] = $e; });
$r1 = $h->handle(contact_request());
$r2 = $h->handle(contact_request());
$r->eq('replay returns first record', 'rec-1', $r1['data']['id'] ?? null);
$r->eq('replay does not re-execute', 'rec-1', $r2['data']['id'] ?? null);
$r->eq('operation executed once', 1, $calls);
$r->check('replay audited', (bool)array_filter($audit, fn($e) => ($e['issueCodes'] ?? []) === ['IDEMPOTENT_REPLAY']));

// Version mismatch.
$ops = new OperationRegistry();
$ops->register('test:contact.create', fn($p, $c) => ['id' => 'x']);
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], $ops);
$res = $h->handle(contact_request(['formVersion' => '9.9.9']));
$r->eq('version mismatch status', 'server-validation-failed', $res['status']);
$r->eq('version mismatch code', 'FORM_VERSION_MISMATCH', $res['issues'][0]['code'] ?? null);

// RBAC fail-closed when permissions declared but no evaluator.
$ir = gated_contact_ir();
$ops = new OperationRegistry();
$ops->register('test:contact.create', fn($p, $c) => ['id' => 'x']);
$h = new TrustedSubmissionHandler(['contact' => $ir], $ops, null);
$res = $h->handle(contact_request());
$r->eq('RBAC not configured', 'RBAC_NOT_CONFIGURED', $res['code'] ?? null);

// RBAC denies missing permission, allows granted.
$h = new TrustedSubmissionHandler(['contact' => gated_contact_ir()], $ops, new SimpleRbacEvaluator());
$res = $h->handle(contact_request(), auth_ctx('u', []));
$r->eq('RBAC denies missing permission', 'PERMISSION_DENIED', $res['code'] ?? null);
$res = $h->handle(contact_request(['idempotencyKey' => 'k2']), auth_ctx('u', ['contact:create']));
$r->eq('RBAC allows granted permission', 'succeeded', $res['status']);

// Audit records paths, never values.
$audit = [];
$ops = new OperationRegistry();
$ops->register('test:contact.create', fn($p, $c) => ['id' => 'x']);
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], $ops, null, function ($e) use (&$audit) { $audit[] = $e; });
$h->handle(contact_request());
$entry = $audit[count($audit) - 1];
$r->check('audit value paths', ($entry['valuePaths'] ?? []) === ['name', 'email', 'message'] || count(array_diff($entry['valuePaths'] ?? [], ['name', 'email', 'message'])) === 0);
$serialized = json_encode($entry);
$r->check('audit never contains email', !str_contains($serialized, 'ada@example.com'));
$r->check('audit never contains name', !str_contains($serialized, 'Ada Lovelace'));

// Operation exception → business-rejected.
$ops = new OperationRegistry();
$ops->register('test:contact.create', function ($p, $c) { throw new \RuntimeException('downstream unavailable'); });
$h = new TrustedSubmissionHandler(['contact' => load_ir('contact.ir.json')], $ops);
$res = $h->handle(contact_request());
$r->eq('operation exception status', 'business-rejected', $res['status']);
$r->eq('operation exception code', 'OPERATION_FAILED', $res['code'] ?? null);

// Reversed input mapping for re-validation (customer-registration).
$ir = load_ir('customer-registration.ir.json');
$captured = [];
$ops = new OperationRegistry();
$ops->register('test:customer.create', function ($p, $c) use (&$captured) { $captured = $p; return ['id' => 'cust-1']; });
$h = new TrustedSubmissionHandler(['customer-registration' => $ir], $ops, new SimpleRbacEvaluator());
$mapped = ['name' => 'Grace Hopper', 'email' => 'grace@example.com', 'type' => 'individual', 'consent' => true, 'age' => 30];
$res = $h->handle(['formId' => 'customer-registration', 'values' => $mapped, 'idempotencyKey' => 'k', 'correlationId' => 'c'], auth_ctx('u', ['customer:create']));
$r->eq('input mapping submission succeeds', 'succeeded', $res['status']);
$r->eq('input mapping payload captured', 'grace@example.com', $captured['email'] ?? null);

exit($r->finish('Submission handler (PHP)'));
