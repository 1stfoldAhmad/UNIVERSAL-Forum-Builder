<?php
/**
 * Shared submission/read security policy — PHP port of
 * packages/form-validation/src/policy.ts and vds_form.policy.
 */
declare(strict_types=1);

namespace VdsForm;

final class Policy
{
    private const FORBIDDEN = ['__proto__' => true, 'prototype' => true, 'constructor' => true];
    private const MAX_DEPTH = 64;
    private const MAX_NODES = 10000;
    private const ASSET_KEYS = ['id' => true, 'name' => true, 'mimeType' => true, 'sizeBytes' => true, 'source' => true, 'localUri' => true, 'assetRef' => true, 'url' => true];
    private static ?object $removed = null;
    private static function removed(): object { return self::$removed ??= new \stdClass(); }

    private static function issue(string $code, string $message, string $path, ?string $fieldId = null): array
    {
        $i = ['code' => $code, 'message' => $message, 'path' => $path, 'severity' => 'error', 'source' => 'schema'];
        if ($fieldId !== null) $i['fieldId'] = $fieldId;
        return $i;
    }

    public static function pathSegments(string $path): ?array
    {
        if ($path === '' || strlen($path) > 512) return null;
        $expanded = preg_replace_callback('/\[(\d*)\]/', fn($m) => '.' . ($m[1] === '' ? '[]' : $m[1]), $path);
        $out = [];
        foreach (explode('.', $expanded) as $part) {
            if ($part === '' || isset(self::FORBIDDEN[$part])) return null;
            $out[] = preg_match('/^\d+$/', $part) ? '[]' : $part;
        }
        return $out;
    }

    public static function normalizePath(string $path): ?string
    {
        $seg = self::pathSegments($path);
        if ($seg === null) return null;
        $out = '';
        foreach ($seg as $part) $out .= $part === '[]' ? '[]' : ($out !== '' ? '.' . $part : $part);
        return $out;
    }

    public static function isPathUnder(string $path, string $ancestor): bool
    {
        $p = self::pathSegments($path); $a = self::pathSegments($ancestor);
        if ($p === null || $a === null || count($p) < count($a)) return false;
        foreach ($a as $i => $seg) if (($p[$i] ?? null) !== $seg) return false;
        return true;
    }

    public static function stripPaths($values, array $templates)
    {
        $normalized = [];
        foreach ($templates as $t) { $n = self::normalizePath((string)$t); if ($n !== null) $normalized[] = $n; }
        $removed = self::removed();
        $walk = function ($value, array $segments, int $depth) use (&$walk, $normalized, $removed) {
            if ($depth > self::MAX_DEPTH) return $removed;
            $norm = implode('.', $segments);
            foreach ($normalized as $t) if (self::isPathUnder($norm, $t)) return $removed;
            if (is_array($value) && array_is_list($value)) {
                $out = [];
                foreach ($value as $i => $item) {
                    $cleaned = $walk($item, array_merge($segments, [(string)$i]), $depth + 1);
                    if ($cleaned !== $removed) $out[] = $cleaned;
                }
                return $out;
            }
            if (is_array($value)) {
                $out = [];
                foreach ($value as $k => $v) {
                    if (isset(self::FORBIDDEN[(string)$k])) continue;
                    $cleaned = $walk($v, array_merge($segments, [(string)$k]), $depth + 1);
                    if ($cleaned !== $removed) $out[$k] = $cleaned;
                }
                return $out;
            }
            return $value;
        };
        return $walk($values, [], 0);
    }

    public static function hiddenTemplatePaths(array $ir, array $visibility, bool $includeHidden = false): array
    {
        if ($includeHidden) return [];
        $out = [];
        foreach ($ir['fields'] as $f) if (($visibility[$f['id']] ?? true) === false) $out[] = $f['key'];
        return $out;
    }

    private static function templates(array $ir): array
    {
        $out = [];
        foreach ($ir['fields'] as $f) { $n = self::normalizePath($f['key']); if ($n !== null) $out[$n] = true; }
        return $out;
    }

    private static function nearestField(array $ir, string $normPath): ?array
    {
        $best = null; $bestLen = -1;
        foreach ($ir['fields'] as $f) {
            $n = self::normalizePath($f['key']);
            if ($n !== null && self::isPathUnder($normPath, $n)) {
                $len = count(self::pathSegments($n) ?? []);
                if ($len > $bestLen) { $best = $f; $bestLen = $len; }
            }
        }
        return $best;
    }

    private static function allowedByFields(array $ir, array $templates, string $normPath): bool
    {
        if (isset($templates[$normPath])) return true;
        foreach ($templates as $t => $_) if (self::isPathUnder($t, $normPath)) return true;
        $field = self::nearestField($ir, $normPath);
        if (!$field) return false;
        $fieldSeg = self::pathSegments(self::normalizePath($field['key']));
        $pathSeg = self::pathSegments($normPath);
        if ($fieldSeg === null || $pathSeg === null) return false;
        $rest = array_slice($pathSeg, count($fieldSeg));
        if (!$rest) return true;
        $vt = $field['valueType'] ?? 'string';
        if ($vt === 'asset' || $vt === 'asset[]') {
            $props = array_values(array_filter($rest, fn($s) => $s !== '[]'));
            return count($props) === 1 && isset(self::ASSET_KEYS[$props[0]]) && count($rest) <= ($vt === 'asset[]' ? 2 : 1);
        }
        if ($vt === 'string[]' || $vt === 'number[]') {
            foreach ($rest as $s) if ($s !== '[]') return false;
            return true;
        }
        return false;
    }

    public static function collectUnknownPropertyIssues(array $ir, array $values, ?array $operationInputs = null): array
    {
        $issues = []; $templates = self::templates($ir); $opRoots = $operationInputs ? array_keys($operationInputs) : [];
        $nodes = 0;
        $walk = function ($value, array $segments, int $depth) use (&$walk, &$issues, &$nodes, $ir, $templates, $opRoots): void {
            if ($depth > self::MAX_DEPTH) { $issues[] = self::issue('PAYLOAD_TOO_DEEP', 'Payload nesting exceeds the security budget.', implode('.', $segments)); return; }
            if (++$nodes > self::MAX_NODES) { $issues[] = self::issue('PAYLOAD_TOO_LARGE', 'Payload exceeds the security node budget.', implode('.', $segments)); return; }
            if (is_array($value) && array_is_list($value)) { foreach ($value as $i => $v) $walk($v, array_merge($segments, [(string)$i]), $depth + 1); return; }
            if (!is_array($value)) return;
            foreach ($value as $k => $v) {
                $child = array_merge($segments, [(string)$k]); $concrete = implode('.', $child);
                if (isset(self::FORBIDDEN[(string)$k])) { $issues[] = self::issue('UNSAFE_PROPERTY', 'Prototype-pollution property rejected.', $concrete); continue; }
                $norm = self::normalizePath($concrete);
                if ($norm === null) { $issues[] = self::issue('UNKNOWN_PROPERTY', 'Property path is not declared.', $concrete); continue; }
                if (count($segments) === 0 && in_array((string)$k, $opRoots, true)) continue;
                if (!self::allowedByFields($ir, $templates, $norm)) $issues[] = self::issue('UNKNOWN_PROPERTY', 'Property is not a declared form field.', $concrete);
                $walk($v, $child, $depth + 1);
            }
        };
        $walk($values, [], 0);
        return $issues;
    }

    private static function typeMatches($value, string $vt): bool
    {
        switch ($vt) {
            case 'string': return is_string($value);
            case 'number': return is_int($value) || is_float($value);
            case 'integer': return is_int($value);
            case 'boolean': return is_bool($value);
            case 'string[]': return is_array($value) && array_is_list($value) && !array_filter($value, fn($v) => !is_string($v));
            case 'number[]': return is_array($value) && array_is_list($value) && !array_filter($value, fn($v) => !is_int($v) && !is_float($v));
            case 'object': case 'asset': return is_array($value) && !array_is_list($value);
            case 'object[]': return is_array($value) && array_is_list($value) && !array_filter($value, fn($v) => !is_array($v) || array_is_list($v));
            case 'asset[]': return is_array($value) && array_is_list($value);
            case 'null': return $value === null;
            default: return false;
        }
    }

    public static function validateOperationInputs(?array $defs, array $values): array
    {
        $out = []; $issues = [];
        if (!$defs) return [$out, $issues];
        $check = function (array $d, $value, string $path) use (&$check, &$issues) {
            if ($value === null) { if (!empty($d['required'])) $issues[] = self::issue('OPERATION_INPUT_REQUIRED', 'Required operation input is missing.', $path); return null; }
            if (!self::typeMatches($value, $d['valueType'] ?? 'string')) { $issues[] = self::issue('OPERATION_INPUT_TYPE_INVALID', 'Expected ' . ($d['valueType'] ?? 'string') . '.', $path); return null; }
            if (is_array($value) && array_is_list($value)) {
                if (empty($d['items'])) return $value;
                $cleaned = [];
                foreach ($value as $i => $item) { $c = $check($d['items'], $item, $path . '.' . $i); if ($c !== null) $cleaned[] = $c; }
                return $cleaned;
            }
            if (is_array($value)) {
                $obj = [];
                foreach ($value as $k => $v) {
                    if (isset(self::FORBIDDEN[(string)$k])) { $issues[] = self::issue('UNSAFE_PROPERTY', 'Prototype-pollution property rejected.', $path . '.' . $k); continue; }
                    $child = $d['properties'][$k] ?? null;
                    if ($child === null) {
                        if (empty($d['additionalProperties'])) $issues[] = self::issue('UNKNOWN_PROPERTY', 'Operation input property is not declared.', $path . '.' . $k);
                        else $obj[$k] = $v;
                        continue;
                    }
                    $c = $check($child, $v, $path . '.' . $k);
                    if ($c !== null) $obj[$k] = $c;
                }
                return $obj;
            }
            return $value;
        };
        foreach ($defs as $name => $d) {
            if (isset(self::FORBIDDEN[(string)$name])) { $issues[] = self::issue('UNSAFE_PROPERTY', 'Operation input name rejected.', (string)$name); continue; }
            $c = $check($d, $values[$name] ?? null, (string)$name);
            if ($c !== null) $out[$name] = $c;
        }
        return [$out, $issues];
    }

    public static function computeReadPolicy(array $ir, ?array $auth, $rbac): array
    {
        $denied = []; $unresolved = []; $issues = [];
        foreach (($ir['security']['fieldAccess'] ?? []) as $fieldId => $access) {
            $perms = $access['read'] ?? [];
            if (!$perms) continue;
            $field = null;
            foreach ($ir['fields'] as $f) if ($f['id'] === $fieldId) { $field = $f; break; }
            $path = $field['key'] ?? $fieldId;
            if ($rbac === null || $auth === null) {
                $denied[$fieldId] = true; $unresolved[] = $fieldId;
                $issues[] = self::issue('FIELD_READ_UNRESOLVED', 'Read authorization cannot be resolved; field is hidden.', $path, (string)$fieldId);
                continue;
            }
            try {
                $decision = $rbac->evaluate($auth, $perms);
                if (empty($decision['allowed'])) {
                    $denied[$fieldId] = true;
                    $missing = $decision['missing'] ?? [];
                    $msg = $missing ? 'Missing read permissions: ' . implode(', ', $missing) : 'Read permission denied.';
                    $issues[] = self::issue('FIELD_READ_DENIED', $msg, $path, (string)$fieldId);
                }
            } catch (\Throwable $e) {
                $denied[$fieldId] = true; $unresolved[] = $fieldId;
                $issues[] = self::issue('FIELD_READ_UNRESOLVED', 'Read evaluator failed: ' . $e->getMessage(), $path, (string)$fieldId);
            }
        }
        return ['denied' => $denied, 'unresolved' => $unresolved, 'issues' => $issues];
    }

    public static function filterReadableValues(array $ir, $values, array $denied)
    {
        if (!$denied || !is_array($values)) return $values;
        $templates = [];
        foreach ($ir['fields'] as $f) if (isset($denied[$f['id']])) $templates[] = $f['key'];
        $cleaned = self::stripPaths($values, $templates);
        return is_array($cleaned) ? $cleaned : [];
    }

    private static function setIn(array $root, string $path, $value): array
    {
        $expanded = preg_replace_callback('/\[(\d*)\]/', fn($m) => '.' . ($m[1] === '' ? '[]' : $m[1]), $path);
        $parts = array_values(array_filter(explode('.', $expanded), fn($p) => $p !== ''));
        $cursor = &$root;
        foreach (array_slice($parts, 0, -1) as $p) {
            if (isset(self::FORBIDDEN[$p])) return $root;
            if (!isset($cursor[$p]) || !is_array($cursor[$p]) || array_is_list($cursor[$p])) $cursor[$p] = [];
            $cursor = &$cursor[$p];
        }
        $last = $parts[count($parts) - 1] ?? null;
        if ($last !== null && !isset(self::FORBIDDEN[$last])) $cursor[$last] = $value;
        return $root;
    }

    public static function prepareSubmissionValues(array $ir, $requestValues, array $visibility): array
    {
        $submission = $ir['submission'] ?? [];
        $issues = [];
        if (!is_array($requestValues) || array_is_list($requestValues)) return ['fieldValues' => [], 'operationInputs' => [], 'issues' => [self::issue('PAYLOAD_INVALID', 'Submission values must be an object.', '')]];
        $opDefs = $submission['operationInputs'] ?? null;
        $opRoots = $opDefs ? array_keys($opDefs) : [];
        $mapping = $submission['inputMapping'] ?? null;
        if ($mapping) $allowedRoots = array_keys($mapping);
        else {
            $allowedRoots = [];
            foreach ($ir['fields'] as $f) if (empty($f['parentId'])) $allowedRoots[] = explode('.', str_replace('[]', '', $f['key']))[0];
        }
        $fieldValues = []; $opRaw = [];
        foreach ($requestValues as $k => $v) {
            if (isset(self::FORBIDDEN[(string)$k])) { $issues[] = self::issue('UNSAFE_PROPERTY', 'Prototype-pollution property rejected.', (string)$k); continue; }
            if (in_array((string)$k, $opRoots, true)) { $opRaw[$k] = $v; continue; }
            if (!in_array((string)$k, $allowedRoots, true)) { $issues[] = self::issue('UNKNOWN_PROPERTY', 'Submission property is not declared.', (string)$k); continue; }
            if ($mapping) {
                $sourcePath = $mapping[$k];
                if (self::normalizePath($sourcePath) === null) { $issues[] = self::issue('INPUT_MAPPING_INVALID', 'Input mapping source path is invalid.', (string)$k); continue; }
                $fieldValues = self::setIn($fieldValues, $sourcePath, $v);
            } else $fieldValues[$k] = $v;
        }
        $hidden = self::hiddenTemplatePaths($ir, $visibility, $submission['includeHidden'] ?? false);
        $cleaned = self::stripPaths($fieldValues, $hidden);
        $fieldValues = is_array($cleaned) ? $cleaned : [];
        $issues = array_merge($issues, self::collectUnknownPropertyIssues($ir, $fieldValues, $opDefs));
        [$opValues, $opIssues] = self::validateOperationInputs($opDefs, $opRaw);
        return ['fieldValues' => $fieldValues, 'operationInputs' => $opValues, 'issues' => array_merge($issues, $opIssues)];
    }
}
