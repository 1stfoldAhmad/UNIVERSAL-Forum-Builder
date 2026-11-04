<?php
/**
 * Adversarial security tests for the trusted Laravel/PHP adapter (audit P0/P1).
 * Mirrors execution-adapters/node/tests/security.test.ts and the Django suite.
 *
 * Run: php tests/run-security.php   (requires PHP >= 8.1, pdo_sqlite for durability)
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
use VdsForm\Idempotency;
use VdsForm\InMemoryIdempotencyStore;
use VdsForm\PdoIdempotencyStore;

$r = new Runner();

// ---- Operation binding (finding 2) ----
[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$res = $h->handle(contact_request(['operationRef' => 'test:admin.wipe']), auth_ctx('u1', ['contact:create', 'admin:wipe']));
$r->eq('operation override rejected status', 'permission-denied', $res['status']);
$r->eq('operation override rejected code', 'OPERATION_OVERRIDE_FORBIDDEN', $res['code'] ?? null);
$r->eq('privileged operation never ran', [], $calls->getArrayCopy());

[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$res = $h->handle(contact_request(['operationRef' => 'test:contact.create']), auth_ctx('u1', ['contact:create']));
$r->eq('matching operation echo executes', 'succeeded', $res['status']);
$r->eq('bound operation ran', ['contact.create'], $calls->getArrayCopy());

[$h, $calls] = make_security_handler(null, ['test:other'], gated_contact_ir());
$res = $h->handle(contact_request(), auth_ctx('u1', ['contact:create']));
$r->eq('allowlist enforced status', 'permission-denied', $res['status']);
$r->eq('allowlist enforced code', 'OPERATION_NOT_ALLOWED', $res['code'] ?? null);
$r->eq('allowlist blocked execution', [], $calls->getArrayCopy());

// ---- Idempotency isolation (finding 3) ----
[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$r1 = $h->handle(contact_request(), auth_ctx('alice', ['contact:create']));
$r2 = $h->handle(contact_request(), auth_ctx('bob', ['contact:create']));
$r->eq('no cross-user replay: both succeed', ['succeeded', 'succeeded'], [$r1['status'], $r2['status']]);
$r->eq('no cross-user replay: both executed', ['contact.create', 'contact.create'], $calls->getArrayCopy());
$r->check('no cross-user replay: distinct records', ($r1['data']['id'] ?? '') !== ($r2['data']['id'] ?? ''));

[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$h->handle(contact_request(), auth_ctx('u1', ['contact:create'], 'a'));
$h->handle(contact_request(), auth_ctx('u1', ['contact:create'], 'b'));
$r->eq('tenant isolation executes twice', 2, count($calls));

[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$r1 = $h->handle(contact_request(), auth_ctx('alice', ['contact:create']));
$r2 = $h->handle(contact_request(), auth_ctx('alice', ['contact:create']));
$r->check('same principal replays identical result', $r1 == $r2);
$r->eq('same principal executed once', ['contact.create'], $calls->getArrayCopy());

[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$r1 = $h->handle(contact_request(), auth_ctx('alice', ['contact:create']));
$swapped = array_merge(VALID_CONTACT, ['email' => 'different@example.com']);
$r2 = $h->handle(contact_request(['values' => $swapped]), auth_ctx('alice', ['contact:create']));
$r->eq('payload swap conflict status', 'business-rejected', $r2['status']);
$r->eq('payload swap conflict code', 'IDEMPOTENCY_KEY_CONFLICT', $r2['code'] ?? null);
$r->eq('payload swap did not re-execute', ['contact.create'], $calls->getArrayCopy());

[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$ok = $h->handle(contact_request(), auth_ctx('alice', ['contact:create']));
$denied = $h->handle(contact_request(), auth_ctx('alice', [])); // permission revoked, same key
$r->eq('authorization before replay: denied', 'PERMISSION_DENIED', $denied['code'] ?? null);
$r->eq('authorization before replay: not re-executed', ['contact.create'], $calls->getArrayCopy());

// Atomic claim at the storage layer: a second claim of an in-progress key is
// rejected (PHP has no async concurrency model; the UNIQUE key is the guarantee).
$store = new InMemoryIdempotencyStore();
$first = $store->claim('scope', 'fp');
$second = $store->claim('scope', 'fp');
$r->eq('atomic claim first wins', 'claimed', $first['kind']);
$r->eq('atomic claim second in-progress', 'in-progress', $second['kind']);
$store->complete('scope', ['status' => 'succeeded']);
$third = $store->claim('scope', 'fp');
$r->eq('completed claim replays', 'replay', $third['kind']);
$conflict = $store->claim('scope', 'other-fp');
$r->eq('different fingerprint conflicts', 'conflict', $conflict['kind']);

// ---- Durable idempotency across restart (finding 3) ----
if (extension_loaded('pdo_sqlite')) {
    $path = tempnam(sys_get_temp_dir(), 'vds-idem-') . '.sqlite';
    $store1 = PdoIdempotencyStore::sqlite($path);
    [$h1, $c1] = make_security_handler($store1, null, gated_contact_ir());
    $r1 = $h1->handle(contact_request(), auth_ctx('alice', ['contact:create']));
    $r->eq('durable first submission succeeds', 'succeeded', $r1['status']);
    $r->eq('durable first executed once', ['contact.create'], $c1->getArrayCopy());
    unset($store1, $h1); // simulate restart

    $store2 = PdoIdempotencyStore::sqlite($path);
    [$h2, $c2] = make_security_handler($store2, null, gated_contact_ir());
    $r2 = $h2->handle(contact_request(), auth_ctx('alice', ['contact:create']));
    $r->check('durable replay matches original', $r1 == $r2);
    $r->eq('durable replay did not re-execute', [], $c2->getArrayCopy());
    unset($store2, $h2);
    @unlink($path);
} elseif (getenv('VDS_REQUIRE_PDO_SQLITE') === '1') {
    // CI sets this so the durable-restart check is guaranteed, never skipped.
    $r->check('pdo_sqlite required (VDS_REQUIRE_PDO_SQLITE=1) but not loaded', false);
} else {
    echo "note: pdo_sqlite not loaded; durable-restart check skipped.\n";
}

// ---- Client auth never trusted (finding 1) ----
[$h, $calls] = make_security_handler(null, null, gated_contact_ir());
$forged = contact_request();
$forged['auth'] = ['userId' => 'attacker', 'permissions' => ['*']];
$res = $h->handle($forged, auth_ctx('real-user', [])); // trusted arg has no perms
$r->eq('forged request auth ignored', 'PERMISSION_DENIED', $res['code'] ?? null);
$r->eq('forged auth did not execute', [], $calls->getArrayCopy());

// Forge EVERY identity field; the operation must see only the server principal.
$seen = null;
$ops = new OperationRegistry();
$ops->register('test:contact.create', function ($p, $c) use (&$seen) { $seen = $c['auth']; return ['id' => 'rec-1']; });
$h = new TrustedSubmissionHandler(['contact' => gated_contact_ir()], $ops, new SimpleRbacEvaluator());
$forged = contact_request();
$forged['auth'] = ['userId' => 'attacker', 'tenantId' => 'evil-tenant', 'roles' => ['admin'], 'permissions' => ['*']];
$serverPrincipal = ['userId' => 'real-user', 'tenantId' => 'real-tenant', 'roles' => ['member'], 'permissions' => ['contact:create']];
$res = $h->handle($forged, $serverPrincipal);
$r->eq('forged all-fields submission succeeds via server principal', 'succeeded', $res['status']);
$r->check('operation sees only server principal (all 4 fields)', $seen === $serverPrincipal, json_encode($seen));

// ---- Canonical determinism ----
$r->check('canonical key-order independent', Idempotency::canonicalJson(['b' => 1, 'a' => ['d' => 2, 'c' => 3]]) === Idempotency::canonicalJson(['a' => ['c' => 3, 'd' => 2], 'b' => 1]));
$r->check('fingerprint stable under reordering', Idempotency::payloadFingerprint(['a' => 1, 'b' => 2]) === Idempotency::payloadFingerprint(['b' => 2, 'a' => 1]));
$r->check('fingerprint sensitive to change', Idempotency::payloadFingerprint(['a' => 1, 'b' => 2]) !== Idempotency::payloadFingerprint(['a' => 1, 'b' => 3]));

exit($r->finish('Security (PHP)'));
