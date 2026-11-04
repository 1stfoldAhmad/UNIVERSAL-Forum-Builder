<?php
/** Shared cross-language security policy vectors (Stage 2–4). */
declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/../src/Policy.php';
require_once __DIR__ . '/../src/Submission.php';

use VdsForm\Policy;
use VdsForm\SimpleRbacEvaluator;

$r = new Runner();
$data = load_shared('security-paths.json');
$ir = fn(array $fields, ?array $access = null) => ['fields' => $fields, 'security' => ['fieldAccess' => $access ?? []]];

foreach ($data['hidden'] as $c) {
    $visibility = [];
    foreach ($c['fields'] as $f) $visibility[$f['id']] = !in_array($f['id'], $c['hiddenFieldIds'], true);
    $actual = Policy::stripPaths($c['values'], Policy::hiddenTemplatePaths($ir($c['fields']), $visibility));
    $r->check('hidden ' . $c['id'], json_encode($actual) === json_encode($c['expected']), json_encode($actual));
}
foreach ($data['unknown'] as $c) {
    $issues = Policy::collectUnknownPropertyIssues($ir($c['fields']), $c['values']);
    $codes = array_map(fn($i) => $i['code'], $issues);
    $ok = true;
    if ($c['expectCodes']) { foreach ($c['expectCodes'] as $code) if (!in_array($code, $codes, true)) { $ok = false; break; } }
    else $ok = count($codes) === 0;
    $r->check('unknown ' . $c['id'], $ok, json_encode($codes));
}
foreach ($data['read'] as $c) {
    $auth = ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => $c['permissions']];
    $rbac = $c['rbac'] ? new SimpleRbacEvaluator() : null;
    $policy = Policy::computeReadPolicy($ir($c['fields'], $c['fieldAccess']), $auth, $rbac);
    $actual = Policy::filterReadableValues($ir($c['fields'], $c['fieldAccess']), $c['values'], $policy['denied']);
    $r->check('read ' . $c['id'], json_encode($actual) === json_encode($c['expected']), json_encode($actual));
}

$r->finish('Security policy vectors (PHP)');
