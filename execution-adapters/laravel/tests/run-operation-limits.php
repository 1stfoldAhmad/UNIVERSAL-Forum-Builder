<?php
/** Shared cross-language operation-input resource-limit vectors. */
declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/../src/Policy.php';

use VdsForm\Policy;

$r = new Runner();
$data = load_shared('operation-limits.json');
foreach ($data['cases'] as $c) {
    [$values, $issues] = Policy::validateOperationInputs($c['defs'], $c['values']);
    $codes = array_map(fn($i) => $i['code'], $issues);
    $ok = true;
    if ($c['expectCodes']) { foreach ($c['expectCodes'] as $code) if (!in_array($code, $codes, true)) { $ok = false; break; } }
    else $ok = count($codes) === 0;
    $r->check('operation-limits ' . $c['id'], $ok, json_encode($codes));
}
$r->finish('Operation limits (PHP)');
