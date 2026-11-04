<?php
/**
 * Submission payload builder — PHP port of packages/form-submission's
 * buildSubmissionPayload (mirrors the verified Python port). Strips hidden
 * fields, applies inputMapping, rejects un-uploaded local assets.
 * STATUS: implemented-not-verified in sandbox (no PHP runtime).
 */
declare(strict_types=1);

namespace VdsForm;

final class Payload
{
    public static function build(array $ir, array $values, array $state, array $submission): array
    {
        $issues = [];
        $includeHidden = $submission['includeHidden'] ?? false;
        $hiddenKeys = [];
        foreach ($ir['fields'] as $f) {
            if (!$includeHidden && ($state['visibility'][$f['id']] ?? true) === false) $hiddenKeys[] = $f['key'];
        }
        $isUnderHidden = function (string $key) use ($hiddenKeys): bool {
            foreach ($hiddenKeys as $h) {
                if ($key === $h || str_starts_with($key, $h . '.') || str_starts_with($key, $h . '[')) return true;
            }
            return false;
        };

        $visibleValues = [];
        foreach ($values as $k => $v) if (!$isUnderHidden($k)) $visibleValues[$k] = $v;

        $stripHidden = function (array $obj, string $prefix) use (&$stripHidden, $isUnderHidden): array {
            $out = [];
            foreach ($obj as $k => $v) {
                $path = $prefix !== '' ? $prefix . '.' . $k : (string)$k;
                if ($isUnderHidden($path)) continue;
                $out[$k] = (is_array($v) && !array_is_list($v)) ? $stripHidden($v, $path) : $v;
            }
            return $out;
        };
        $cleaned = $stripHidden($visibleValues, '');

        $mapping = $submission['inputMapping'] ?? null;
        if ($mapping) {
            $payload = [];
            foreach ($mapping as $param => $sourcePath) {
                if ($isUnderHidden($sourcePath)) continue;
                $v = Expressions::getPath($cleaned, $sourcePath);
                if ($v === null) {
                    $issues[] = ['code' => 'MAPPING_SOURCE_MISSING', 'message' => "Mapping source \"$sourcePath\" has no value.", 'path' => $sourcePath, 'severity' => 'warning', 'source' => 'schema'];
                    continue;
                }
                $payload[$param] = $v;
            }
        } else {
            $payload = $cleaned;
        }

        $checkAssets = function ($v, string $path) use (&$checkAssets, &$issues): void {
            if (is_array($v) && array_is_list($v)) {
                foreach ($v as $i => $x) $checkAssets($x, $path . '.' . $i);
                return;
            }
            if (is_array($v) && array_key_exists('localUri', $v) && !array_key_exists('assetRef', $v)) {
                $issues[] = ['code' => 'ASSET_NOT_UPLOADED', 'message' => 'Asset must be uploaded before submission.', 'path' => $path, 'severity' => 'error', 'source' => 'field'];
            }
        };
        foreach ($ir['fields'] as $f) {
            if (in_array($f['valueType'] ?? '', ['asset', 'asset[]'], true)) {
                $v = Expressions::getPath($payload, $f['key']);
                if ($v === null) $v = Expressions::getPath($cleaned, $f['key']);
                $checkAssets($v, $f['key']);
            }
        }
        return [$payload, $issues];
    }
}
