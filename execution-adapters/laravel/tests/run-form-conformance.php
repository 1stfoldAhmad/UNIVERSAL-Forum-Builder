<?php
/**
 * Cross-language compiler/validation/payload conformance (PHP). Expected results
 * come from the SHARED fixtures (forms.json); inputs are the deterministic FormIR
 * compiled by the TS compiler (fixtures/ir/*.ir.json). Proves the PHP server
 * reproduces the TS validation + payload semantics — the same check Django runs.
 *
 * Run: php tests/run-form-conformance.php   (requires PHP >= 8.1)
 */
declare(strict_types=1);

require __DIR__ . '/lib.php';
require __DIR__ . '/../src/Expressions.php';
require __DIR__ . '/../src/Validation.php';
require __DIR__ . '/../src/Payload.php';

use VdsForm\Validation;
use VdsForm\Payload;
use VdsForm\Expressions;

$r = new Runner();
$forms = load_shared('forms.json');

foreach ($forms['validation'] as $case) {
    $ir = load_ir('validation-' . $case['id'] . '.ir.json');
    [$state, ] = Validation::computeEffectiveState($ir, $case['values']);
    $result = Validation::validateValues($ir, $case['values'], $state, $case['phase']);
    $actual = array_map(fn($i) => ['code' => $i['code'], 'path' => $i['path']], $result['issues']);
    $expected = $case['expectIssues'];
    if (!$expected) {
        $errors = array_filter($result['issues'], fn($i) => $i['severity'] === 'error');
        $r->check('validation ' . $case['id'] . ' (no errors)', count($errors) === 0, json_encode($actual));
    } else {
        $ok = true;
        foreach ($expected as $e) {
            $found = false;
            foreach ($actual as $a) if ($a['code'] === $e['code'] && $a['path'] === $e['path']) { $found = true; break; }
            if (!$found) { $ok = false; break; }
        }
        $r->check('validation ' . $case['id'], $ok, 'expected ' . json_encode($expected) . ', got ' . json_encode($actual));
    }
}

foreach ($forms['payload'] as $case) {
    $ir = load_ir('payload-' . $case['id'] . '.ir.json');
    [$state, ] = Validation::computeEffectiveState($ir, $case['values']);
    [$payload, ] = Payload::build($ir, $case['values'], $state, $ir['submission']);
    $r->check('payload ' . $case['id'], Expressions::deepEqual($payload, $case['expectPayload']), 'expected ' . json_encode($case['expectPayload']) . ', got ' . json_encode($payload));
}

exit($r->finish('Form conformance (PHP)'));
