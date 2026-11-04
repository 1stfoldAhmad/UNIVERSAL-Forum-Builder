<?php
/** Idempotency lease/expiry recovery for the trusted Laravel/PHP adapter. */
declare(strict_types=1);

require __DIR__ . '/lib.php';
require_once __DIR__ . '/../src/Expressions.php';
require_once __DIR__ . '/../src/Validation.php';
require_once __DIR__ . '/../src/Idempotency.php';
require_once __DIR__ . '/../src/Submission.php';

use VdsForm\IdempotencyStore;
use VdsForm\InMemoryIdempotencyStore;
use VdsForm\PdoIdempotencyStore;

$r = new Runner();
$result = ['status' => 'succeeded', 'operationRef' => 'test:contact.create', 'data' => ['id' => 'r1'], 'idempotencyKey' => 'k', 'durationMs' => 1];

$store = new InMemoryIdempotencyStore();
$r->eq('in-memory claim', ['kind' => 'claimed'], $store->claim('k', 'fp', ['now' => 1000, 'leaseMs' => 1000]));
$r->eq('in-memory in-progress', ['kind' => 'in-progress'], $store->claim('k', 'fp', ['now' => 1500, 'leaseMs' => 1000]));
$r->eq('in-memory conflict', ['kind' => 'conflict'], $store->claim('k', 'other', ['now' => 1500]));
$r->eq('in-memory expired', ['kind' => 'expired', 'claimedAt' => 1000, 'leaseExpiresAt' => 2000], $store->claim('k', 'fp', ['now' => 2001, 'leaseMs' => 1000]));
$store->complete('k', $result);
$r->eq('in-memory replay after reconcile', ['kind' => 'replay', 'result' => $result], $store->claim('k', 'fp', ['now' => 3000]));

if (extension_loaded('pdo_sqlite')) {
    $path = tempnam(sys_get_temp_dir(), 'vds-idem-');
    $a = PdoIdempotencyStore::sqlite($path);
    $r->eq('pdo claim', ['kind' => 'claimed'], $a->claim('k', 'fp', ['now' => 1000, 'leaseMs' => 1000]));
    unset($a);
    $b = PdoIdempotencyStore::sqlite($path);
    $r->eq('pdo restart in-progress', ['kind' => 'in-progress'], $b->claim('k', 'fp', ['now' => 1500, 'leaseMs' => 1000]));
    $r->eq('pdo restart expired', ['kind' => 'expired', 'claimedAt' => 1000, 'leaseExpiresAt' => 2000], $b->claim('k', 'fp', ['now' => 2001, 'leaseMs' => 1000]));
    $r->eq('pdo conflict', ['kind' => 'conflict'], $b->claim('k', 'other', ['now' => 2001]));
    $b->complete('k', $result);
    unset($b);
    $c = PdoIdempotencyStore::sqlite($path);
    $r->eq('pdo replay after restart', ['kind' => 'replay', 'result' => $result], $c->claim('k', 'fp', ['now' => 9999]));
    unset($c);
    unlink($path);
} else {
    fwrite(STDERR, "note: pdo_sqlite not installed; durable-restart check skipped (runs in CI).\n");
}

final class ExpiredStore implements IdempotencyStore
{
    public function claim(string $key, string $fingerprint, array $opts = []): array
    {
        return ['kind' => 'expired', 'claimedAt' => 1, 'leaseExpiresAt' => 2];
    }
    public function complete(string $key, array $result): void {}
    public function release(string $key): void {}
}

[$h, $calls] = make_security_handler(new ExpiredStore());
$res = $h->handle(contact_request(), auth_ctx('u1', []));
$r->eq('handler expired status', 'business-rejected', $res['status']);
$r->eq('handler expired code', 'IDEMPOTENCY_RECOVERY_REQUIRED', $res['code'] ?? null);
$r->eq('handler expired did not execute', [], $calls->getArrayCopy());

$r->finish('Idempotency recovery (PHP)');
