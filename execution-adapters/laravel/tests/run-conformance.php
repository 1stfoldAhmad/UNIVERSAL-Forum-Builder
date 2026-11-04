<?php
/**
 * Cross-language conformance runner (PHP). Loads the SHARED fixtures from
 * packages/form-conformance/fixtures/expressions.json and runs them against the
 * PHP engine. Exit code 0 = all pass, 1 = failures. This is the same fixture
 * file the TypeScript and Python adapters verify against.
 *
 * Run: php tests/run-conformance.php   (requires PHP >= 8.1)
 */
declare(strict_types=1);

require_once __DIR__ . '/../src/Expressions.php';

use VdsForm\Expressions;

$fixtures = getenv('VDS_CONFORMANCE_FIXTURES') ?: __DIR__ . '/../../../packages/form-conformance/fixtures';
$path = $fixtures . '/expressions.json';
$suite = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

$passed = 0; $failed = 0; $failures = [];
foreach ($suite['cases'] as $case) {
    $actual = Expressions::evaluate($case['expr'], $case['scope'] ?? []);
    $expect = $case['expect'];
    if ($expect['ok']) {
        $ok = ($actual['ok'] ?? false) === true && Expressions::deepEqual($actual['value'] ?? null, $expect['value']);
    } else {
        $ok = ($actual['ok'] ?? false) === false && ($actual['code'] ?? null) === $expect['code'];
    }
    if ($ok) { $passed++; }
    else {
        $failed++;
        $failures[] = sprintf("  FAIL %s\n    expected: %s\n    actual:   %s", $case['id'], json_encode($expect), json_encode($actual));
    }
}

$total = $passed + $failed;
echo "Conformance (vds.expr/1, PHP): $passed/$total passed, $failed failed.\n";
foreach ($failures as $f) fwrite(STDERR, $f . "\n");
exit($failed === 0 ? 0 : 1);
