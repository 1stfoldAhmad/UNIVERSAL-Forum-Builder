<?php
/**
 * Submission payload builder — PHP port of packages/form-submission.
 * Hidden values are stripped recursively (including repeater rows); undeclared
 * properties are rejected; typed operation inputs are validated separately.
 */
declare(strict_types=1);

namespace VdsForm;

final class Payload
{
    public static function build(array $ir, array $values, array $state, array $submission): array
    {
        $issues = [];
        $hidden = Policy::hiddenTemplatePaths($ir, $state['visibility'] ?? [], $submission['includeHidden'] ?? false);
        $stripped = Policy::stripPaths($values, $hidden);
        $stripped = is_array($stripped) ? $stripped : [];
        $opDefs = $submission['operationInputs'] ?? null;
        $opRoots = $opDefs ? array_keys($opDefs) : [];
        $opRaw = []; $fieldValues = [];
        foreach ($stripped as $k => $v) {
            if (in_array((string)$k, $opRoots, true)) $opRaw[$k] = $v;
            else $fieldValues[$k] = $v;
        }
        $issues = array_merge($issues, Policy::collectUnknownPropertyIssues($ir, $fieldValues));
        [$opValues, $opIssues] = Policy::validateOperationInputs($opDefs, $opRaw);
        $issues = array_merge($issues, $opIssues);
        foreach ($issues as $i) if (($i['severity'] ?? '') === 'error') return [[], $issues];

        $mapping = $submission['inputMapping'] ?? null;
        if ($mapping) {
            $payload = [];
            foreach ($mapping as $param => $sourcePath) {
                $skip = false;
                if (empty($submission['includeHidden'])) foreach ($hidden as $h) if (Policy::isPathUnder($sourcePath, $h)) { $skip = true; break; }
                if ($skip) continue;
                $v = Expressions::getPath($fieldValues, $sourcePath);
                if ($v === null) {
                    $issues[] = ['code' => 'MAPPING_SOURCE_MISSING', 'message' => "Mapping source \"$sourcePath\" has no value.", 'path' => $sourcePath, 'severity' => 'warning', 'source' => 'schema'];
                    continue;
                }
                $payload[$param] = $v;
            }
        } else {
            $payload = $fieldValues;
        }
        $payload = array_merge($payload, $opValues);

        $checkAssets = function ($v, string $path, string $fieldId) use (&$checkAssets, &$issues): void {
            if (is_array($v) && array_is_list($v)) { foreach ($v as $i => $x) $checkAssets($x, $path . '.' . $i, $fieldId); return; }
            if (is_array($v) && array_key_exists('localUri', $v) && !array_key_exists('assetRef', $v)) {
                $issues[] = ['code' => 'ASSET_NOT_UPLOADED', 'message' => 'Asset must be uploaded before submission.', 'path' => $path, 'fieldId' => $fieldId, 'severity' => 'error', 'source' => 'field'];
            }
        };
        foreach (Validation::expandFieldInstances($ir, $fieldValues) as $inst) {
            $f = $inst['field'];
            if (in_array($f['valueType'] ?? '', ['asset', 'asset[]'], true)) {
                $checkAssets(Expressions::getPath($fieldValues, $inst['concreteKey']), $inst['concreteKey'], $f['id']);
            }
        }
        return [$payload, $issues];
    }
}
