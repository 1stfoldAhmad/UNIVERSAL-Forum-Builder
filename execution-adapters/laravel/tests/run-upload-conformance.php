<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
require_once __DIR__ . '/../src/Expressions.php';
require_once __DIR__ . '/../src/Validation.php';
use VdsForm\Validation;

$fixtures = json_decode(file_get_contents(dirname(__DIR__, 3) . '/packages/form-conformance/fixtures/uploads.json'), true, 512, JSON_THROW_ON_ERROR);
$checks = 0;
foreach ($fixtures['cases'] as $case) {
    $ir = ['fields' => [[
        'id' => 'upload', 'key' => 'upload', 'type' => 'file', 'valueType' => 'asset',
        'validation' => ['accept' => $case['accept']],
    ]]];
    $values = ['upload' => [
        'name' => $case['name'], 'mimeType' => $case['mimeType'],
        'sizeBytes' => 10, 'assetRef' => 'provider-ref',
    ]];
    [$state, ] = Validation::computeEffectiveState($ir, $values);
    $result = Validation::validateValues($ir, $values, $state, 'change');
    $actual = !array_filter($result['issues'], static fn(array $issue): bool => $issue['code'] === 'ASSET_TYPE_REJECTED');
    if ($actual !== $case['allowed']) {
        fwrite(STDERR, "FAIL {$case['id']} expected " . ($case['allowed'] ? 'allowed' : 'rejected') . PHP_EOL);
        exit(1);
    }
    $checks++;
}
foreach ($fixtures['sizeBoundaries'] as $case) {
    if (($case['sizeBytes'] <= $case['maxSizeBytes']) !== $case['allowed']) {
        fwrite(STDERR, "FAIL size boundary" . PHP_EOL);
        exit(1);
    }
    $checks++;
}
echo "Upload conformance: {$checks} checks passed." . PHP_EOL;
