<?php
/** Shared cross-language asset accept/size conformance (asset-upload.json). */
declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/../src/Assets.php';

use VdsForm\Assets;

$r = new Runner();
$data = load_shared('asset-upload.json');
foreach ($data['cases'] as $c) {
    $type = Assets::typeAllowed(['name' => $c['name'], 'mimeType' => $c['mimeType']], $c['accept']);
    $size = Assets::sizeAllowed($c['sizeBytes'], $c['maxSizeBytes'] ?? null);
    $r->check('asset type ' . $c['id'], $type === $c['expect']['typeAllowed'], var_export($type, true));
    $r->check('asset size ' . $c['id'], $size === $c['expect']['sizeAllowed'], var_export($size, true));
}
// Regression: extension tokens must match the filename, not a MIME substring.
$r->check('jpg matches image/jpeg', Assets::typeAllowed(['name' => 'p.jpg', 'mimeType' => 'image/jpeg'], ['.jpg']) === true);
$r->check('png does not match .jpg', Assets::typeAllowed(['name' => 'p.png', 'mimeType' => 'image/png'], ['.jpg']) === false);
$r->check('normalize alias', Assets::normalizeMimeType('image/jpg') === 'image/jpeg');
$r->check('extension canonical', Assets::fileExtension('photo.JPG') === 'jpeg');
$r->finish('Asset conformance (PHP)');
