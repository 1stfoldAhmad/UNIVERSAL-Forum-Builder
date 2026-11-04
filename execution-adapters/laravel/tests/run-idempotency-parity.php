<?php
/**
 * Cross-language idempotency parity (PHP): the PHP adapter must reproduce the
 * shared canonical-JSON / fingerprint / scoped-key vectors byte-for-byte (the
 * same fixture the TypeScript and Python adapters run).
 *
 * Run: php tests/run-idempotency-parity.php   (requires PHP >= 8.1)
 */
declare(strict_types=1);

require __DIR__ . '/lib.php';
require __DIR__ . '/../src/Idempotency.php';

use VdsForm\Idempotency;

$r = new Runner();
$fixture = load_shared('idempotency.json');

foreach ($fixture['canonical'] as $i => $c) {
    $r->eq("canonical[$i]", $c['expected'], Idempotency::canonicalJson($c['input']));
}
foreach ($fixture['fingerprint'] as $i => $c) {
    $r->eq("fingerprint[$i]", $c['expected'], Idempotency::payloadFingerprint($c['input']));
}
foreach ($fixture['scopedKey'] as $i => $c) {
    $in = $c['input'];
    $r->eq("scopedKey[$i]", $c['expected'], Idempotency::scopedIdempotencyKey($in['tenantId'], $in['userId'], $in['formId'], $in['operationRef'], $in['idempotencyKey']));
}

exit($r->finish('Idempotency parity (PHP)'));
