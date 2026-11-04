<?php
/**
 * Laravel HTTP controller tests (PHP) — exercise the P0 security boundary:
 * auth is derived from the server-side principal / a host authResolver, NEVER
 * from the request body. Tests both the framework-agnostic process() core and
 * the full submit() path via an injectable responder + a fake Illuminate request.
 *
 * In CI, when illuminate/http is installed, an additional check runs submit()
 * against a real Illuminate\Http\Request to prove the integration.
 *
 * Run: php tests/run-controller.php   (requires PHP >= 8.1)
 */
declare(strict_types=1);

require __DIR__ . '/lib.php';
require __DIR__ . '/../src/Expressions.php';
require __DIR__ . '/../src/Validation.php';
require __DIR__ . '/../src/Idempotency.php';
require __DIR__ . '/../src/Submission.php';
require __DIR__ . '/../src/LaravelController.php';

use VdsForm\TrustedSubmissionHandler;
use VdsForm\OperationRegistry;
use VdsForm\SimpleRbacEvaluator;
use VdsForm\LaravelController;

$r = new Runner();

/** Minimal Illuminate\Http\Request stand-in for submit() tests. */
final class FakeRequest
{
    public function __construct(private string $content, private $user = null, private array $headers = []) {}
    public function getContent(): string { return $this->content; }
    public function user() { return $this->user; }
    public function route($key) { return null; }
    public function header($key) { return $this->headers[$key] ?? null; }
}

/** Authenticated principal stand-in (Laravel Authenticatable). */
final class FakeUser
{
    public function __construct(private $id) {}
    public function getAuthIdentifier() { return $this->id; }
}

function make_handler(?array $ir = null): TrustedSubmissionHandler
{
    $ops = new OperationRegistry();
    $ops->register('test:contact.create', fn($p, $c) => array_merge(['id' => 'rec-1'], $p));
    return new TrustedSubmissionHandler(['contact' => $ir ?? load_ir('contact.ir.json')], $ops, new SimpleRbacEvaluator());
}

function submit_body(array $over = []): string
{
    return json_encode(array_merge(['formId' => 'contact', 'values' => VALID_CONTACT, 'idempotencyKey' => 'k', 'correlationId' => 'c'], $over));
}

// --- process() core ---
$controller = new LaravelController();
[$status, $body] = $controller->process(json_decode(submit_body(), true), null, make_handler());
$r->eq('process success status', 200, $status);
$r->eq('process success body', 'succeeded', $body['status']);

[$status, $body] = $controller->process(json_decode(submit_body(['values' => ['name' => 'A', 'email' => 'bad', 'message' => 'x']]), true), null, make_handler());
$r->eq('process validation 422', 422, $status);

// P0: body auth is rejected outright.
[$status, $body] = $controller->process(json_decode(submit_body(['auth' => ['userId' => 'attacker', 'permissions' => ['*']]]), true), null, make_handler(gated_contact_ir()));
$r->eq('body auth rejected status', 400, $status);
$r->eq('body auth rejected code', 'AUTH_IN_BODY_FORBIDDEN', $body['code'] ?? null);

// Gated form denies anonymous (no user → auth=null → RBAC denies).
[$status, $body] = $controller->process(json_decode(submit_body(), true), null, make_handler(gated_contact_ir()));
$r->eq('gated anonymous denied status', 403, $status);
$r->eq('gated anonymous denied code', 'PERMISSION_DENIED', $body['code'] ?? null);

// Gated form: authenticated user without VDS perms is denied (fail-closed default).
[$status, $body] = $controller->process(json_decode(submit_body(), true), new FakeUser(7), make_handler(gated_contact_ir()));
$r->eq('gated user without perms denied', 403, $status);

// authResolver reading verified claims is the only other auth source.
$resolver = fn() => auth_ctx('token-user', ['contact:create'], 't9');
[$status, $body] = $controller->process(json_decode(submit_body(), true), null, make_handler(gated_contact_ir()), $resolver);
$r->eq('resolver grants access', 200, $status);

// allow_anonymous=false requires auth.
[$status, $body] = $controller->process(json_decode(submit_body(), true), null, make_handler(), null, false);
$r->eq('allow_anonymous false → 401', 401, $status);
$r->eq('allow_anonymous false code', 'AUTH_REQUIRED', $body['code'] ?? null);

// --- submit() via injectable responder + fake request ---
$captured = null;
$respond = function ($body, $status) use (&$captured) { $captured = [$status, $body]; return 'json-response'; };
$controller = new LaravelController($respond);
$out = $controller->submit(new FakeRequest(submit_body()), make_handler());
$r->eq('submit returns responder output', 'json-response', $out);
$r->eq('submit success status', 200, $captured[0]);
$r->eq('submit success body', 'succeeded', $captured[1]['status']);

// submit() rejects body auth.
$captured = null;
$controller = new LaravelController($respond);
$controller->submit(new FakeRequest(submit_body(['auth' => ['permissions' => ['*']]])), make_handler(gated_contact_ir()));
$r->eq('submit body auth rejected', 400, $captured[0]);
$r->eq('submit body auth code', 'AUTH_IN_BODY_FORBIDDEN', $captured[1]['code'] ?? null);

// submit() with an authenticated user on a gated form (default perms [] → denied).
$captured = null;
$controller = new LaravelController($respond);
$controller->submit(new FakeRequest(submit_body(), new FakeUser(7)), make_handler(gated_contact_ir()));
$r->eq('submit gated user denied', 403, $captured[0]);

// submit() with a resolver granting access.
$captured = null;
$controller = new LaravelController($respond, fn($request) => auth_ctx('token-user', ['contact:create']));
$controller->submit(new FakeRequest(submit_body()), make_handler(gated_contact_ir()));
$r->eq('submit resolver grants access', 200, $captured[0]);

// submit() rejects invalid JSON.
$captured = null;
$controller = new LaravelController($respond);
$controller->submit(new FakeRequest('{not json'), make_handler());
$r->eq('submit invalid json 400', 400, $captured[0]);
$r->eq('submit invalid json code', 'INVALID_JSON', $captured[1]['code'] ?? null);

// --- Optional: real Illuminate\Http\Request when available (CI) ---
if (class_exists(\Illuminate\Http\Request::class)) {
    $captured = null;
    $controller = new LaravelController($respond);
    $req = \Illuminate\Http\Request::create('/api/forms/submit', 'POST', [], [], [], [], submit_body());
    $req->headers->set('Content-Type', 'application/json');
    $controller->submit($req, make_handler());
    $r->eq('real Illuminate request success', 200, $captured[0]);
    $r->eq('real Illuminate request body', 'succeeded', $captured[1]['status']);
} else {
    echo "note: illuminate/http not installed; real-Request integration check skipped (runs in CI).\n";
}

exit($r->finish('Laravel controller (PHP)'));
