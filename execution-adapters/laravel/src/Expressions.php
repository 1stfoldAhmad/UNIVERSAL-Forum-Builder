<?php
/**
 * vds.expr/1 expression engine — PHP port (Laravel execution adapter).
 *
 * Faithful port of the TypeScript reference (packages/form-expressions) and the
 * verified Python port (execution-adapters/django). Executes the SAME canonical
 * AST with the SAME semantics; verified against the SAME shared conformance
 * fixtures (packages/form-conformance/fixtures/expressions.json) via
 * tests/run-conformance.php. Closed typed operator set, budgets, no eval of
 * arbitrary code. Errors are returned as values, never thrown across boundaries.
 *
 * STATUS: implemented-not-verified in the Arena sandbox (no PHP runtime). Run
 * `php tests/run-conformance.php` where PHP >= 8.1 is available to verify.
 */
declare(strict_types=1);

namespace VdsForm;

final class Expressions
{
    public const DEFAULT_LIMITS = [
        'maxNodes' => 5000,
        'maxDepth' => 64,
        'maxCollectionItems' => 10000,
        'maxStringLength' => 1000000,
    ];

    private const FORBIDDEN = ['__proto__' => true, 'constructor' => true, 'prototype' => true];

    public static function ok($value): array { return ['ok' => true, 'value' => $value]; }
    public static function err(string $code, string $message): array { return ['ok' => false, 'code' => $code, 'message' => $message]; }

    private static function isNum($v): bool { return (is_int($v) || is_float($v)) && is_finite((float)$v); }
    private static function isStr($v): bool { return is_string($v); }
    private static function isBool($v): bool { return is_bool($v); }

    public static function isSafePath(string $path): bool
    {
        foreach (explode('.', $path) as $seg) {
            if (isset(self::FORBIDDEN[str_replace('[]', '', $seg)])) return false;
        }
        return true;
    }

    /** Read by dot path; '*' projects arrays. Missing -> null. */
    public static function getPath($root, string $path)
    {
        if (!self::isSafePath($path)) return null;
        $segments = explode('.', $path);
        $current = [$root];
        foreach ($segments as $seg) {
            $next = [];
            foreach ($current as $node) {
                if ($node === null) { $next[] = null; continue; }
                if ($seg === '*') {
                    if (is_array($node) && array_is_list($node)) { foreach ($node as $x) $next[] = $x; }
                    else $next[] = null;
                } elseif (preg_match('/^\d+$/', $seg) && is_array($node) && array_is_list($node)) {
                    $idx = (int)$seg;
                    $next[] = $node[$idx] ?? null;
                } else {
                    if (!is_array($node) || array_is_list($node)) { $next[] = null; continue; }
                    $next[] = $node[$seg] ?? null;
                }
            }
            $current = $next;
        }
        return in_array('*', $segments, true) ? $current : ($current[0] ?? null);
    }

    public static function parseRef(string $ref): ?array
    {
        if ($ref === 'index') return ['index', ''];
        if (!preg_match('/^(field|context|item|parent|source):([A-Za-z_][A-Za-z0-9_.\-*\[\]]*)$/', $ref, $m)) return null;
        $kind = $m[1]; $path = $m[2];
        foreach (explode('.', $path) as $seg) if (isset(self::FORBIDDEN[$seg])) return null;
        return [$kind, $path];
    }

    public static function deepEqual($a, $b): bool
    {
        if ($a === null || $b === null) return $a === null && $b === null;
        if (is_bool($a) || is_bool($b)) return is_bool($a) && is_bool($b) && $a === $b;
        if (self::isNum($a) && self::isNum($b)) return $a == $b;
        if (self::isStr($a) && self::isStr($b)) return $a === $b;
        if (is_array($a) && is_array($b)) {
            $aList = array_is_list($a); $bList = array_is_list($b);
            if ($aList !== $bList) return false;
            if (count($a) !== count($b)) return false;
            if ($aList) { foreach ($a as $i => $v) if (!self::deepEqual($v, $b[$i])) return false; return true; }
            foreach ($a as $k => $v) if (!array_key_exists($k, $b) || !self::deepEqual($v, $b[$k])) return false;
            return true;
        }
        return false;
    }

    public static function measureExpr(array $expr): array
    {
        $nodes = 0; $maxDepth = 0;
        $stack = [['e' => $expr, 'd' => 1]];
        while ($stack) {
            $item = array_pop($stack);
            $e = $item['e']; $d = $item['d'];
            $nodes++;
            if ($d > $maxDepth) $maxDepth = $d;
            if (isset($e['op'])) foreach ($e['args'] ?? [] as $a) $stack[] = ['e' => $a, 'd' => $d + 1];
        }
        return ['nodes' => $nodes, 'depth' => $maxDepth];
    }

    private static function roundHalfAway(float $x, int $digits): float
    {
        if (!is_finite($x)) return $x;
        $factor = 10 ** $digits;
        $scaled = (float)sprintf('%.15g', abs($x) * $factor);
        $rounded = floor($scaled + 0.5);
        $sign = $x < 0 ? -1 : 1;
        return $sign * $rounded / $factor;
    }

    private static function finite(float $v): array
    {
        return is_finite($v) ? self::ok($v) : self::err('EXPR_OVERFLOW', 'Numeric result is not finite.');
    }

    private static function isoDate($v): ?int
    {
        if (!self::isStr($v)) return null;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}(T.*)?$/', $v)) return null;
        $s = strlen($v) === 10 ? $v . 'T00:00:00Z' : $v;
        try {
            $dt = new \DateTimeImmutable($s);
            return (int)($dt->getTimestamp() * 1000);
        } catch (\Exception $e) { return null; }
    }

    private static function numbers(array $args, bool $skipNull = false)
    {
        $list = $args;
        if (count($args) === 1 && is_array($args[0]) && array_is_list($args[0])) $list = $args[0];
        $out = [];
        foreach ($list as $v) {
            if ($v === null && $skipNull) continue;
            if (!self::isNum($v)) return self::err('EXPR_TYPE_ERROR', 'Arithmetic expects finite numbers.');
            $out[] = $v;
        }
        return ['ok' => true, 'value' => $out];
    }

    private static function isEmpty($v): array
    {
        if ($v === null) return self::ok(true);
        if (self::isStr($v)) return self::ok(strlen($v) === 0);
        if (is_array($v)) return self::ok(count($v) === 0);
        return self::ok(false);
    }

    private static function contains($c, $x): array
    {
        if (self::isStr($c) && self::isStr($x)) return self::ok(str_contains($c, $x));
        if (is_array($c) && array_is_list($c)) {
            foreach ($c as $v) if (self::deepEqual($v, $x)) return self::ok(true);
            return self::ok(false);
        }
        return self::err('EXPR_TYPE_ERROR', 'contains expects (string, string) or (array, value).');
    }

    private static function len($v, array $limits): array
    {
        if (self::isStr($v)) return self::ok(strlen($v));
        if (is_array($v) && array_is_list($v)) {
            return count($v) > $limits['maxCollectionItems']
                ? self::err('EXPR_LIMIT_EXCEEDED', 'Collection too large.') : self::ok(count($v));
        }
        if ($v === null) return self::ok(0);
        return self::err('EXPR_TYPE_ERROR', 'len expects string or array.');
    }

    private static function reduce(array $args, array $limits, callable $fn, float $init, bool $skipNull = false): array
    {
        $n = self::numbers($args, $skipNull);
        if (!$n['ok']) return $n;
        $acc = $init;
        foreach ($n['value'] as $v) $acc = $fn($acc, $v);
        return self::finite($acc);
    }

    private static function cmp(callable $fn): callable
    {
        return function (array $args) use ($fn) {
            $a = $args[0]; $b = $args[1];
            if (self::isNum($a) && self::isNum($b)) return self::ok($fn($a, $b));
            if (self::isStr($a) && self::isStr($b)) return self::ok($fn($a, $b));
            return self::err('EXPR_TYPE_ERROR', 'Comparison expects two numbers or two strings.');
        };
    }

    private static function toNumber($v): array
    {
        if ($v === null) return self::ok(null);
        if (self::isNum($v)) return self::ok($v);
        if (self::isBool($v)) return self::ok($v ? 1 : 0);
        if (self::isStr($v) && trim($v) !== '' && is_numeric($v)) {
            $f = (float)$v;
            if (is_finite($f)) return self::ok($f == (int)$f && !str_contains($v, '.') && !str_contains(strtolower($v), 'e') ? (int)$f : $f);
        }
        return self::err('EXPR_TYPE_ERROR', 'toNumber cannot convert value.');
    }

    private static function toBoolean($v): array
    {
        if (self::isBool($v)) return self::ok($v);
        if ($v === null) return self::ok(false);
        if (self::isNum($v)) return self::ok($v != 0);
        if (self::isStr($v)) return self::ok(strlen($v) > 0);
        if (is_array($v) && array_is_list($v)) return self::ok(count($v) > 0);
        return self::ok(true);
    }

    private static function operators(): array
    {
        return [
            'and' => fn($a) => self::allBool($a) ? self::ok(!in_array(false, $a, true)) : self::err('EXPR_TYPE_ERROR', 'and expects booleans.'),
            'or' => fn($a) => self::allBool($a) ? self::ok(in_array(true, $a, true)) : self::err('EXPR_TYPE_ERROR', 'or expects booleans.'),
            'not' => fn($a) => self::isBool($a[0]) ? self::ok(!$a[0]) : self::err('EXPR_TYPE_ERROR', 'not expects a boolean.'),
            'if' => fn($a) => self::isBool($a[0]) ? self::ok($a[0] ? $a[1] : $a[2]) : self::err('EXPR_TYPE_ERROR', 'if expects a boolean condition.'),
            'coalesce' => function ($a) { foreach ($a as $x) if ($x !== null) return self::ok($x); return self::ok(null); },
            'eq' => fn($a) => self::ok(self::deepEqual($a[0], $a[1])),
            'neq' => fn($a) => self::ok(!self::deepEqual($a[0], $a[1])),
            'gt' => self::cmp(fn($a, $b) => $a > $b),
            'gte' => self::cmp(fn($a, $b) => $a >= $b),
            'lt' => self::cmp(fn($a, $b) => $a < $b),
            'lte' => self::cmp(fn($a, $b) => $a <= $b),
            'isNull' => fn($a) => self::ok($a[0] === null),
            'isEmpty' => fn($a) => self::isEmpty($a[0]),
            'in' => function ($a) {
                if (!is_array($a[1]) || !array_is_list($a[1])) return self::err('EXPR_TYPE_ERROR', 'in expects (value, array).');
                foreach ($a[1] as $v) if (self::deepEqual($v, $a[0])) return self::ok(true);
                return self::ok(false);
            },
            'contains' => fn($a) => self::contains($a[0], $a[1]),
            'concat' => function ($a, $l) {
                $out = '';
                foreach ($a as $x) {
                    if ($x === null) continue;
                    if (!(self::isStr($x) || self::isNum($x) || self::isBool($x))) return self::err('EXPR_TYPE_ERROR', 'concat expects strings/numbers/booleans.');
                    $out .= self::isBool($x) ? ($x ? 'true' : 'false') : (string)$x;
                    if (strlen($out) > $l['maxStringLength']) return self::err('EXPR_LIMIT_EXCEEDED', 'concat exceeded string budget.');
                }
                return self::ok($out);
            },
            'len' => fn($a, $l) => self::len($a[0], $l),
            'startsWith' => fn($a) => self::isStr($a[0]) && self::isStr($a[1]) ? self::ok(str_starts_with($a[0], $a[1])) : self::err('EXPR_TYPE_ERROR', 'startsWith expects strings.'),
            'endsWith' => fn($a) => self::isStr($a[0]) && self::isStr($a[1]) ? self::ok(str_ends_with($a[0], $a[1])) : self::err('EXPR_TYPE_ERROR', 'endsWith expects strings.'),
            'lower' => fn($a) => self::isStr($a[0]) ? self::ok(strtolower($a[0])) : self::err('EXPR_TYPE_ERROR', 'lower expects a string.'),
            'upper' => fn($a) => self::isStr($a[0]) ? self::ok(strtoupper($a[0])) : self::err('EXPR_TYPE_ERROR', 'upper expects a string.'),
            'trim' => fn($a) => self::isStr($a[0]) ? self::ok(trim($a[0])) : self::err('EXPR_TYPE_ERROR', 'trim expects a string.'),
            'add' => fn($a, $l) => self::reduce($a, $l, fn($x, $y) => $x + $y, 0),
            'mul' => fn($a, $l) => self::reduce($a, $l, fn($x, $y) => $x * $y, 1),
            'sub' => function ($a, $l) {
                $n = self::numbers($a);
                if (!$n['ok']) return $n;
                if (!$n['value']) return self::ok(0);
                $acc = $n['value'][0];
                foreach (array_slice($n['value'], 1) as $v) $acc -= $v;
                return self::finite($acc);
            },
            'div' => function ($a) {
                if (!self::isNum($a[0]) || !self::isNum($a[1])) return self::err('EXPR_TYPE_ERROR', 'div expects numbers.');
                if ($a[1] == 0) return self::err('EXPR_DIVISION_BY_ZERO', 'Division by zero.');
                return self::finite($a[0] / $a[1]);
            },
            'mod' => function ($a) {
                if (!self::isNum($a[0]) || !self::isNum($a[1])) return self::err('EXPR_TYPE_ERROR', 'mod expects numbers.');
                if ($a[1] == 0) return self::err('EXPR_DIVISION_BY_ZERO', 'Modulo by zero.');
                return self::finite(fmod((float)$a[0], (float)$a[1]));
            },
            'abs' => fn($a) => self::isNum($a[0]) ? self::ok(abs($a[0])) : self::err('EXPR_TYPE_ERROR', 'abs expects a number.'),
            'round' => function ($a) {
                if (!self::isNum($a[0])) return self::err('EXPR_TYPE_ERROR', 'round expects a number.');
                $d = $a[1] ?? 0;
                if (!self::isNum($d) || floor((float)$d) != $d || $d < 0 || $d > 10) return self::err('EXPR_TYPE_ERROR', 'round digits must be integer 0..10.');
                return self::ok(self::roundHalfAway((float)$a[0], (int)$d));
            },
            'sum' => fn($a, $l) => self::reduce($a, $l, fn($x, $y) => $x + $y, 0, true),
            'avg' => function ($a, $l) {
                $n = self::numbers($a, true);
                if (!$n['ok']) return $n;
                if (!$n['value']) return self::ok(null);
                return self::finite(array_sum($n['value']) / count($n['value']));
            },
            'min' => function ($a, $l) { $n = self::numbers($a, true); if (!$n['ok']) return $n; return self::ok($n['value'] ? min($n['value']) : null); },
            'max' => function ($a, $l) { $n = self::numbers($a, true); if (!$n['ok']) return $n; return self::ok($n['value'] ? max($n['value']) : null); },
            'count' => function ($a) {
                if (is_array($a[0]) && array_is_list($a[0])) return self::ok(count($a[0]));
                if ($a[0] === null) return self::ok(0);
                return self::err('EXPR_TYPE_ERROR', 'count expects an array.');
            },
            'toNumber' => fn($a) => self::toNumber($a[0]),
            'toString' => function ($a) {
                $v = $a[0];
                if ($v === null) return self::ok('');
                if (self::isStr($v)) return self::ok($v);
                if (self::isBool($v)) return self::ok($v ? 'true' : 'false');
                if (self::isNum($v)) return self::ok((string)$v);
                return self::ok(json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            },
            'toBoolean' => fn($a) => self::toBoolean($a[0]),
            'dateAddDays' => function ($a) {
                $t = self::isoDate($a[0]);
                if ($t === null || !self::isNum($a[1]) || floor((float)$a[1]) != $a[1]) return self::err('EXPR_TYPE_ERROR', 'dateAddDays expects (ISO date, integer days).');
                $dt = (new \DateTimeImmutable('@' . intdiv($t + (int)$a[1] * 86400000, 1000)))->setTimezone(new \DateTimeZone('UTC'));
                return self::ok($dt->format('Y-m-d'));
            },
            'dateDiffDays' => function ($a) {
                $x = self::isoDate($a[0]); $y = self::isoDate($a[1]);
                if ($x === null || $y === null) return self::err('EXPR_TYPE_ERROR', 'dateDiffDays expects ISO dates.');
                return self::ok((int)round(($x - $y) / 86400000));
            },
        ];
    }

    private static function allBool(array $a): bool
    {
        foreach ($a as $x) if (!self::isBool($x)) return false;
        return true;
    }

    public const ARITY = [
        'and' => [1, -1], 'or' => [1, -1], 'not' => [1, 1], 'if' => [3, 3], 'coalesce' => [1, -1],
        'eq' => [2, 2], 'neq' => [2, 2], 'gt' => [2, 2], 'gte' => [2, 2], 'lt' => [2, 2], 'lte' => [2, 2],
        'isNull' => [1, 1], 'isEmpty' => [1, 1], 'in' => [2, 2], 'contains' => [2, 2],
        'concat' => [0, -1], 'len' => [1, 1], 'startsWith' => [2, 2], 'endsWith' => [2, 2],
        'lower' => [1, 1], 'upper' => [1, 1], 'trim' => [1, 1],
        'add' => [0, -1], 'mul' => [0, -1], 'sub' => [1, -1], 'div' => [2, 2], 'mod' => [2, 2],
        'abs' => [1, 1], 'round' => [1, 2], 'sum' => [1, -1], 'avg' => [1, -1], 'min' => [1, -1], 'max' => [1, -1], 'count' => [1, 1],
        'toNumber' => [1, 1], 'toString' => [1, 1], 'toBoolean' => [1, 1],
        'dateAddDays' => [2, 2], 'dateDiffDays' => [2, 2],
    ];

    private static function resolveRef(string $ref, array $scope, array $limits): array
    {
        $parsed = self::parseRef($ref);
        if (!$parsed) return self::err('EXPR_REFERENCE_INVALID', "Invalid reference \"$ref\".");
        [$kind, $path] = $parsed;
        $values = $scope['values'] ?? [];
        switch ($kind) {
            case 'field':
                $v = self::getPath($values, $path);
                if (is_array($v) && array_is_list($v) && str_contains($path, '*') && count($v) > $limits['maxCollectionItems'])
                    return self::err('EXPR_LIMIT_EXCEEDED', 'Wildcard projection exceeded collection budget.');
                return self::ok($v);
            case 'item':
                if (!isset($scope['rowPrefix'])) return self::err('EXPR_SCOPE_ERROR', "item: reference \"$ref\" used outside a repeater row.");
                return self::ok(self::getPath($values, $scope['rowPrefix'] . '.' . $path));
            case 'parent':
                $full = isset($scope['parentPrefix']) && $scope['parentPrefix'] !== '' ? $scope['parentPrefix'] . '.' . $path : $path;
                return self::ok(self::getPath($values, $full));
            case 'index':
                if (!isset($scope['rowIndex'])) return self::err('EXPR_SCOPE_ERROR', 'index reference used outside a repeater row.');
                return self::ok($scope['rowIndex']);
            case 'context':
                return self::ok(self::getPath($scope['context'] ?? [], $path));
            case 'source':
                return self::ok($scope['sources'][$path] ?? null);
        }
        return self::err('EXPR_REFERENCE_INVALID', "Invalid reference \"$ref\".");
    }

    public static function evaluate(array $expr, array $scope): array
    {
        $limits = array_merge(self::DEFAULT_LIMITS, $scope['limits'] ?? []);
        $m = self::measureExpr($expr);
        if ($m['nodes'] > $limits['maxNodes']) return self::err('EXPR_LIMIT_EXCEEDED', "Expression has {$m['nodes']} nodes (max {$limits['maxNodes']}).");
        if ($m['depth'] > $limits['maxDepth']) return self::err('EXPR_LIMIT_EXCEEDED', "Expression depth {$m['depth']} exceeds max {$limits['maxDepth']}.");

        $budget = $limits['maxNodes'] * 4;
        $ops = self::operators();
        $functions = $scope['functions'] ?? [];

        $evalNode = function (array $e, int $d) use (&$evalNode, &$budget, $limits, $scope, $ops, $functions) {
            $budget--;
            if ($budget < 0) return self::err('EXPR_LIMIT_EXCEEDED', 'Evaluation budget exhausted.');
            if ($d > $limits['maxDepth']) return self::err('EXPR_LIMIT_EXCEEDED', 'Depth budget exceeded.');
            if (array_key_exists('const', $e)) return self::ok($e['const']);
            if (isset($e['ref'])) return self::resolveRef($e['ref'], $scope, $limits);
            if (!isset($e['op'])) return self::err('EXPR_REFERENCE_INVALID', 'Malformed expression node.');

            $op = $e['op'];
            $argsAst = $e['args'] ?? [];
            $ownOp = isset($ops[$op]);
            $ownFn = isset($functions[$op]);
            if (!$ownOp && !$ownFn) return self::err('EXPR_UNKNOWN_OPERATOR', "Unknown operator \"$op\".");
            if ($ownOp) {
                [$lo, $hi] = self::ARITY[$op];
                if (count($argsAst) < $lo || ($hi !== -1 && count($argsAst) > $hi))
                    return self::err('EXPR_TYPE_ERROR', "Operator \"$op\" has wrong arity.");
            }

            if ($op === 'and' || $op === 'or') {
                foreach ($argsAst as $a) {
                    $r = $evalNode($a, $d + 1);
                    if (!$r['ok']) return $r;
                    if (!self::isBool($r['value'])) return self::err('EXPR_TYPE_ERROR', "$op expects booleans.");
                    if ($op === 'and' && $r['value'] === false) return self::ok(false);
                    if ($op === 'or' && $r['value'] === true) return self::ok(true);
                }
                return self::ok($op === 'and');
            }
            if ($op === 'if') {
                $c = $evalNode($argsAst[0], $d + 1);
                if (!$c['ok']) return $c;
                if (!self::isBool($c['value'])) return self::err('EXPR_TYPE_ERROR', 'if expects a boolean condition.');
                return $evalNode($c['value'] ? $argsAst[1] : $argsAst[2], $d + 1);
            }
            if ($op === 'coalesce') {
                foreach ($argsAst as $a) {
                    $r = $evalNode($a, $d + 1);
                    if (!$r['ok']) return $r;
                    if ($r['value'] !== null) return self::ok($r['value']);
                }
                return self::ok(null);
            }

            $args = [];
            foreach ($argsAst as $a) {
                $r = $evalNode($a, $d + 1);
                if (!$r['ok']) return $r;
                $args[] = $r['value'];
            }
            return $ownOp ? $ops[$op]($args, $limits) : $functions[$op]($args);
        };

        return $evalNode($expr, 1);
    }

    public static function evaluateBoolean(array $expr, array $scope): array
    {
        $r = self::evaluate($expr, $scope);
        if (!$r['ok']) return $r;
        if (!self::isBool($r['value'])) return self::err('EXPR_TYPE_ERROR', 'Condition must evaluate to a boolean.');
        return $r;
    }
}
