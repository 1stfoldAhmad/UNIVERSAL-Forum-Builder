<?php
/** Audit remediation regressions for the trusted PHP handler (Stages 3–4). */
declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/../src/Expressions.php';
require_once __DIR__ . '/../src/Validation.php';
require_once __DIR__ . '/../src/Idempotency.php';
require_once __DIR__ . '/../src/Submission.php';

use VdsForm\TrustedSubmissionHandler;
use VdsForm\OperationRegistry;
use VdsForm\SimpleRbacEvaluator;

$r = new Runner();
$valid = ['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'message' => 'Hello from the PHP adapter.'];
$auth = ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => []];
$req = fn(array $values, string $key = 'k') => ['formId' => 'contact', 'values' => $values, 'idempotencyKey' => $key, 'correlationId' => 'c'];
$make = function (array $ir, callable $op) use (&$calls) {
    $calls = new ArrayObject();
    $ops = new OperationRegistry();
    $ops->register('test:contact.create', function ($p, $c) use ($op, $calls) { $calls[] = $p; return $op($p, $c); });
    return [new TrustedSubmissionHandler(['contact' => $ir], $ops, new SimpleRbacEvaluator()), $calls];
};

$ir = load_ir('contact.ir.json');
[$h, $calls] = $make($ir, fn($p) => $p);
$res = $h->handle($req(array_merge($valid, ['isAdmin' => true])), $auth);
$r->eq('unknown root rejected status', 'server-validation-failed', $res['status']);
$r->check('unknown root code', in_array('UNKNOWN_PROPERTY', array_column($res['issues'] ?? [], 'code'), true));
$r->eq('unknown root operation not called', 0, count($calls));

[$h, $calls] = $make($ir, fn($p) => $p);
$proto = json_decode('{"name":"Ada","email":"ada@example.com","message":"Hello from the PHP adapter.","__proto__":{"polluted":true}}', true);
$res = $h->handle($req($proto), $auth);
$r->eq('prototype pollution rejected status', 'server-validation-failed', $res['status']);
$r->check('prototype pollution code', in_array('UNSAFE_PROPERTY', array_column($res['issues'] ?? [], 'code'), true));
$r->eq('prototype pollution operation not called', 0, count($calls));

$ir = load_ir('contact.ir.json');
$ir['security']['fieldAccess'] = ['email' => ['read' => ['email:read']]];
[$h, $calls] = $make($ir, fn($p) => array_merge($p, ['id' => 'rec-1']));
$res = $h->handle($req($valid), $auth);
$r->eq('read-protected result succeeded', 'succeeded', $res['status']);
$r->check('read-protected email absent from result', !array_key_exists('email', $res['data'] ?? []));
$r->eq('visible result sibling preserved', 'Ada Lovelace', $res['data']['name'] ?? null);

$ir = load_ir('contact.ir.json');
$ir['submission']['operationInputs'] = ['meta' => ['valueType' => 'object', 'properties' => ['source' => ['valueType' => 'string']]]];
[$h, $calls] = $make($ir, fn($p) => $p);
$ok = $h->handle($req(array_merge($valid, ['meta' => ['source' => 'web']]), 'ok'), $auth);
$r->eq('typed operation input accepted', 'succeeded', $ok['status']);
$r->eq('typed operation input forwarded', ['source' => 'web'], $calls[0]['meta'] ?? null);
$bad = $h->handle($req(array_merge($valid, ['meta' => ['source' => 'web', 'extra' => true]]), 'bad'), $auth);
$r->eq('unknown operation input member rejected', 'server-validation-failed', $bad['status']);
$r->eq('unknown operation input member not executed', 1, count($calls));

$ir = load_ir('contact.ir.json');
$ir['security']['fieldAccess'] = ['email' => ['read' => ['email:read']]];
[$h, $calls] = $make($ir, fn($p) => array_merge($p, ['id' => 'rec-1']));
$first = $h->handle($req($valid, 'same-key'), ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => ['email:read']]);
$second = $h->handle($req($valid, 'same-key'), $auth);
$r->eq('read replay first succeeded', 'succeeded', $first['status']);
$r->eq('read replay second succeeded', 'succeeded', $second['status']);
$r->check('read replay first exposes permitted email', array_key_exists('email', $first['data'] ?? []));
$r->check('read replay second redacts revoked email', !array_key_exists('email', $second['data'] ?? []));
$r->eq('read replay executed once', 1, count($calls));

$ir = load_ir('contact.ir.json');
$ir['fields'][] = ['id' => 'items', 'key' => 'items', 'type' => 'repeater', 'valueType' => 'object[]', 'children' => ['secret']];
$ir['fields'][] = ['id' => 'secret', 'key' => 'items[].secret', 'type' => 'text', 'valueType' => 'string', 'repeaterId' => 'items'];
$ir['security']['fieldAccess'] = ['secret' => ['write' => ['secret:write']]];
[$h, $calls] = $make($ir, fn($p) => $p);
$res = $h->handle($req(array_merge($valid, ['items' => [['secret' => null]]])), $auth);
$r->eq('repeater null write denied status', 'permission-denied', $res['status']);
$r->eq('repeater null write denied code', 'FIELD_WRITE_DENIED', $res['code'] ?? null);
$r->eq('repeater null write operation not called', 0, count($calls));

$r->finish('Remediation (PHP)');
