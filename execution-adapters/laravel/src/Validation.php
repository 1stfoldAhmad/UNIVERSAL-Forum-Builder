<?php
/**
 * Server-side effective-state + validation — PHP port of packages/form-validation
 * (mirrors the verified Python port). Operates on the shared deterministic FormIR.
 * STATUS: implemented-not-verified in sandbox (no PHP runtime).
 */
declare(strict_types=1);

namespace VdsForm;

final class Validation
{
    private const FORMAT_PATTERNS = [
        'email' => '/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/',
        'url' => '/^https?:\/\/[^\s\/$.?#].[^\s]*$/i',
        'phone' => '/^\+?[0-9\s\-().]{6,20}$/',
        'date' => '/^\d{4}-\d{2}-\d{2}$/',
        'time' => '/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/',
        'date-time' => '/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/',
        'uuid' => '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i',
        'postal-code' => '/^[A-Za-z0-9][A-Za-z0-9\s-]{2,11}$/',
        'color' => '/#([0-9a-f]{3}|[0-9a-f]{6})$/i',
        'barcode' => '/^[A-Za-z0-9-]{4,64}$/',
    ];

    public static function isEmptyValue($v): bool
    {
        if ($v === null) return true;
        if (is_string($v)) return strlen($v) === 0;
        if (is_array($v)) return count($v) === 0;
        return false;
    }

    public static function isSafePattern(string $pattern): bool
    {
        if (strlen($pattern) > 1000) return false;
        if (preg_match('/(\+|\*|\{)\s*(\)|\])?\s*(\+|\*|\{[0-9,]+\})/', $pattern)) return false;
        return @preg_match('/' . str_replace('/', '\/', $pattern) . '/', '') !== false;
    }

    public static function typeMatches($value, string $valueType): bool
    {
        switch ($valueType) {
            case 'string': return is_string($value);
            case 'number': return (is_int($value) || is_float($value));
            case 'integer': return is_int($value);
            case 'boolean': return is_bool($value);
            case 'string[]': return is_array($value) && array_is_list($value) && self::all($value, 'is_string');
            case 'number[]': return is_array($value) && array_is_list($value) && self::all($value, fn($v) => is_int($v) || is_float($v));
            case 'object': case 'asset': return is_array($value) && !array_is_list($value);
            case 'object[]': return is_array($value) && array_is_list($value) && self::all($value, fn($v) => is_array($v) && !array_is_list($v));
            case 'asset[]': return is_array($value) && array_is_list($value);
            case 'null': return $value === null;
            default: return true;
        }
    }

    private static function all(array $a, callable $fn): bool
    {
        foreach ($a as $v) if (!$fn($v)) return false;
        return true;
    }

    public static function computeEffectiveState(array $ir, array $values, array $context = [], array $sources = []): array
    {
        $state = ['visibility' => [], 'required' => [], 'disabled' => [], 'readonly' => []];
        foreach ($ir['fields'] as $f) {
            $state['visibility'][$f['id']] = !($f['hidden'] ?? false);
            $state['required'][$f['id']] = $f['required'] ?? false;
            $state['disabled'][$f['id']] = $f['disabled'] ?? false;
            $state['readonly'][$f['id']] = $f['readonly'] ?? false;
        }
        $errors = [];
        foreach ($ir['conditions'] ?? [] as $c) {
            $r = Expressions::evaluateBoolean($c['when'], ['values' => $values, 'context' => $context, 'sources' => $sources]);
            if (!$r['ok']) { $errors[] = ['id' => $c['id'], 'message' => $r['message']]; continue; }
            if ($r['value'] === true) {
                foreach ($c['effects'] ?? [] as $eff) {
                    $s = $eff['set'] ?? []; $fid = $eff['fieldId'];
                    foreach (['visible' => 'visibility', 'required' => 'required', 'disabled' => 'disabled', 'readonly' => 'readonly'] as $key => $target) {
                        if (array_key_exists($key, $s)) $state[$target][$fid] = $s[$key];
                    }
                }
            }
        }
        return [$state, $errors];
    }

    public static function expandFieldInstances(array $ir, array $values): array
    {
        $out = [];
        $repeaters = [];
        foreach ($ir['fields'] as $f) if ($f['type'] === 'repeater') $repeaters[$f['id']] = $f;
        foreach ($ir['fields'] as $f) {
            if (in_array($f['type'], ['repeater', 'group'], true)) $out[] = ['field' => $f, 'concreteKey' => $f['key']];
            if (empty($f['repeaterId'])) {
                if (!in_array($f['type'], ['repeater', 'group'], true)) $out[] = ['field' => $f, 'concreteKey' => $f['key']];
                continue;
            }
            $repeater = $repeaters[$f['repeaterId']] ?? null;
            if (!$repeater) continue;
            $rows = Expressions::getPath($values, $repeater['key']);
            $count = is_array($rows) && array_is_list($rows) ? count($rows) : 0;
            for ($i = 0; $i < $count; $i++) {
                $concrete = str_replace($repeater['key'] . '[]', $repeater['key'] . '.' . $i, $f['key']);
                $out[] = ['field' => $f, 'concreteKey' => $concrete, 'rowScope' => ['rowPrefix' => $repeater['key'] . '.' . $i, 'rowIndex' => $i, 'parentPrefix' => '']];
            }
        }
        return $out;
    }

    private static function issue(string $code, string $message, string $path, ?string $fieldId, string $source = 'field', string $severity = 'error'): array
    {
        return ['code' => $code, 'message' => $message, 'path' => $path, 'fieldId' => $fieldId, 'source' => $source, 'severity' => $severity];
    }

    private static function validateOne(array $inst, array $values, array $state, string $phase): array
    {
        $field = $inst['field']; $concrete = $inst['concreteKey']; $issues = [];
        if (($state['visibility'][$field['id']] ?? true) === false) return $issues;
        $ftype = $field['type']; $v = $field['validation'] ?? [];

        if (in_array($ftype, ['group', 'repeater'], true)) {
            if ($ftype === 'repeater') {
                $rows = Expressions::getPath($values, $field['key']);
                $count = is_array($rows) && array_is_list($rows) ? count($rows) : 0;
                if (($state['required'][$field['id']] ?? false) && $count === 0) $issues[] = self::issue('REQUIRED', 'At least one entry is required.', $concrete, $field['id']);
                if (isset($v['minItems']) && $count < $v['minItems']) $issues[] = self::issue('MIN_ITEMS', "At least {$v['minItems']} entries required.", $concrete, $field['id']);
                if (isset($v['maxItems']) && $count > $v['maxItems']) $issues[] = self::issue('MAX_ITEMS', "At most {$v['maxItems']} entries allowed.", $concrete, $field['id']);
            }
            return $issues;
        }

        $value = Expressions::getPath($values, $concrete);
        $required = $state['required'][$field['id']] ?? ($field['required'] ?? false);
        $disabled = $state['disabled'][$field['id']] ?? ($field['disabled'] ?? false);

        if ($required && !$disabled) {
            if ($ftype === 'consent') {
                if ($value !== true) $issues[] = self::issue('REQUIRED', 'This consent is required.', $concrete, $field['id']);
            } elseif (self::isEmptyValue($value)) {
                $issues[] = self::issue('REQUIRED', 'This field is required.', $concrete, $field['id']);
            }
        }
        if (self::isEmptyValue($value)) return $issues;

        if (!self::typeMatches($value, $field['valueType'] ?? 'string')) {
            $issues[] = self::issue('TYPE_INVALID', 'Expected ' . ($field['valueType'] ?? 'string') . '.', $concrete, $field['id']);
            return $issues;
        }

        if (is_string($value)) {
            if (isset($v['minLength']) && strlen($value) < $v['minLength']) $issues[] = self::issue('MIN_LENGTH', "Must be at least {$v['minLength']} characters.", $concrete, $field['id']);
            if (isset($v['maxLength']) && strlen($value) > $v['maxLength']) $issues[] = self::issue('MAX_LENGTH', "Must be at most {$v['maxLength']} characters.", $concrete, $field['id']);
            $fmt = $v['format'] ?? null;
            if ($fmt && isset(self::FORMAT_PATTERNS[$fmt])) {
                if (!preg_match(self::FORMAT_PATTERNS[$fmt], $value)) $issues[] = self::issue('FORMAT_INVALID', "Invalid $fmt format.", $concrete, $field['id']);
                if ($fmt === 'date' && preg_match(self::FORMAT_PATTERNS['date'], $value)) {
                    [$y, $m, $d] = array_map('intval', explode('-', $value));
                    if (!checkdate($m, $d, $y)) $issues[] = self::issue('FORMAT_INVALID', 'Invalid calendar date.', $concrete, $field['id']);
                }
            }
            if (!empty($v['pattern'])) {
                if (!self::isSafePattern($v['pattern'])) $issues[] = self::issue('PATTERN_UNSAFE', 'Validation pattern rejected as unsafe.', $concrete, $field['id']);
                elseif (strlen($value) <= 10000 && !preg_match('/' . str_replace('/', '\/', $v['pattern']) . '/', $value)) $issues[] = self::issue('PATTERN_MISMATCH', 'Value does not match the required pattern.', $concrete, $field['id']);
            }
        }

        if (is_int($value) || is_float($value)) {
            if (isset($v['min']) && $value < $v['min']) $issues[] = self::issue('MIN_VALUE', "Must be >= {$v['min']}.", $concrete, $field['id']);
            if (isset($v['max']) && $value > $v['max']) $issues[] = self::issue('MAX_VALUE', "Must be <= {$v['max']}.", $concrete, $field['id']);
            if (isset($v['precision'])) {
                $scaled = $value * (10 ** $v['precision']);
                if (abs($scaled - round($scaled)) > 1e-9) $issues[] = self::issue('PRECISION_EXCEEDED', "At most {$v['precision']} decimal places allowed.", $concrete, $field['id']);
            }
        }

        if (is_array($value) && array_is_list($value)) {
            if (isset($v['minItems']) && count($value) < $v['minItems']) $issues[] = self::issue('MIN_ITEMS', "Select at least {$v['minItems']}.", $concrete, $field['id']);
            if (isset($v['maxItems']) && count($value) > $v['maxItems']) $issues[] = self::issue('MAX_ITEMS', "Select at most {$v['maxItems']}.", $concrete, $field['id']);
        }

        if (in_array($field['valueType'] ?? '', ['asset', 'asset[]'], true)) {
            $assets = is_array($value) && array_is_list($value) ? $value : [$value];
            if (empty($v['multiple']) && is_array($value) && array_is_list($value) && count($value) > 1) $issues[] = self::issue('MULTIPLE_NOT_ALLOWED', 'Only one file is allowed.', $concrete, $field['id']);
            foreach ($assets as $a) {
                if (!is_array($a)) continue;
                $mime = $a['mimeType'] ?? null;
                if (!empty($v['accept']) && $mime) {
                    $ok = false;
                    foreach ($v['accept'] as $acc) {
                        if ($acc === $mime || (str_ends_with($acc, '/*') && str_starts_with($mime, substr($acc, 0, -1))) || (str_starts_with($acc, '.') && str_contains($mime, substr($acc, 1)))) { $ok = true; break; }
                    }
                    if (!$ok) $issues[] = self::issue('ASSET_TYPE_REJECTED', "File type $mime is not allowed.", $concrete, $field['id']);
                }
                if (isset($v['maxSizeBytes']) && isset($a['sizeBytes']) && $a['sizeBytes'] > $v['maxSizeBytes']) $issues[] = self::issue('ASSET_TOO_LARGE', "File exceeds {$v['maxSizeBytes']} bytes.", $concrete, $field['id']);
                if ($phase === 'submit' && empty($a['assetRef'])) $issues[] = self::issue('ASSET_NOT_UPLOADED', 'File must be uploaded before submitting.', $concrete, $field['id']);
            }
        }
        return $issues;
    }

    public static function validateValues(array $ir, array $values, array $state, string $phase = 'submit', array $context = [], array $sources = []): array
    {
        $issues = [];
        foreach (self::expandFieldInstances($ir, $values) as $inst) {
            foreach (self::validateOne($inst, $values, $state, $phase) as $i) $issues[] = $i;
        }
        foreach ($ir['crossFieldRules'] ?? [] as $rule) {
            $r = Expressions::evaluateBoolean($rule['expr'], ['values' => $values, 'context' => $context, 'sources' => $sources]);
            if (!$r['ok']) $issues[] = self::issue('RULE_EVALUATION_FAILED', $r['message'], $rule['path'] ?? '', null);
            elseif ($r['value'] === false) {
                $msg = $rule['message'] ?? 'Cross-field rule failed.';
                if (is_array($msg)) $msg = $msg['en'] ?? (reset($msg) ?: 'Cross-field rule failed.');
                $issues[] = self::issue('CROSS_FIELD', $msg, $rule['path'] ?? '', null, 'field', $rule['severity'] ?? 'error');
            }
        }
        $valid = true;
        foreach ($issues as $i) if ($i['severity'] === 'error') { $valid = false; break; }
        return ['valid' => $valid, 'issues' => $issues];
    }
}
