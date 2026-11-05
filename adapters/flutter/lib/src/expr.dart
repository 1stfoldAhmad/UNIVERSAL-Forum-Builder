/// vds.expr/1 expression engine — Dart port (Flutter renderer).
/// Faithful port of the TS reference / verified Python & PHP ports. Closed
/// typed operator set, budgets, error-as-value. Verified against the shared
/// conformance fixtures (packages/form-conformance/fixtures/expressions.json).
library;

import 'dart:convert';
import 'dart:math' as math;

class ExprResult {
  final bool ok;
  final Object? value;
  final String? code;
  final String? message;
  const ExprResult.ok(this.value) : ok = true, code = null, message = null;
  const ExprResult.err(this.code, this.message) : ok = false, value = null;
  Map<String, dynamic> toJson() => ok
      ? {'ok': true, 'value': value}
      : {'ok': false, 'code': code, 'message': message};
}

const Map<String, int> defaultLimits = {
  'maxNodes': 5000,
  'maxDepth': 64,
  'maxCollectionItems': 10000,
  'maxStringLength': 1000000,
};
const Set<String> forbiddenSegments = {'__proto__', 'constructor', 'prototype'};
final RegExp _refRe = RegExp(
  r'^(field|context|item|parent|source):([A-Za-z_][A-Za-z0-9_.\-*\[\]]*)$|^index$',
);
final RegExp _digits = RegExp(r'^\d+$');

bool isNum(Object? v) => v is num && v.isFinite;
bool isStr(Object? v) => v is String;
bool isBool(Object? v) => v is bool;

bool isSafePath(String path) => path
    .split('.')
    .every((s) => !forbiddenSegments.contains(s.replaceAll('[]', '')));

Object? getPath(Object? root, String path) {
  if (!isSafePath(path)) return null;
  final segments = path.split('.');
  List<Object?> current = [root];
  for (final seg in segments) {
    final next = <Object?>[];
    for (final node in current) {
      if (node == null) {
        next.add(null);
        continue;
      }
      if (seg == '*') {
        if (node is List) {
          next.addAll(node);
        } else {
          next.add(null);
        }
      } else if (_digits.hasMatch(seg) && node is List) {
        final idx = int.parse(seg);
        next.add(idx < node.length ? node[idx] : null);
      } else {
        if (node is! Map) {
          next.add(null);
          continue;
        }
        next.add(node[seg]);
      }
    }
    current = next;
  }
  return segments.contains('*')
      ? current
      : (current.isNotEmpty ? current[0] : null);
}

({String kind, String path})? parseRef(String ref) {
  if (ref == 'index') return (kind: 'index', path: '');
  final m = _refRe.firstMatch(ref);
  if (m == null) return null;
  final kind = m.group(1);
  final path = m.group(2) ?? '';
  if (kind == null) return (kind: 'index', path: '');
  if (path.split('.').any(forbiddenSegments.contains)) return null;
  return (kind: kind, path: path);
}

bool deepEqual(Object? a, Object? b) {
  if (a == null || b == null) return a == null && b == null;
  if (a is bool || b is bool) return a is bool && b is bool && a == b;
  if (isNum(a) && isNum(b)) return a == b;
  if (isStr(a) && isStr(b)) return a == b;
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

String _str(Object? v) {
  if (v is bool) return v ? 'true' : 'false';
  if (v is String) return v;
  if (v is num) return v.toString();
  return jsonEncode(v);
}

double roundHalfAway(double x, int digits) {
  if (!x.isFinite) return x;
  final factor = math.pow(10, digits).toDouble();
  final scaled = double.parse((x.abs() * factor).toStringAsPrecision(15));
  final rounded = (scaled + 0.5).floor();
  final sign = x < 0 ? -1 : 1;
  return sign * rounded / factor;
}

int? _isoDate(Object? v) {
  if (v is! String) return null;
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}(T.*)?$').hasMatch(v)) return null;
  final s = v.length == 10 ? '${v}T00:00:00Z' : v;
  final dt = DateTime.tryParse(s.replaceAll('Z', '+00:00'));
  return dt?.millisecondsSinceEpoch;
}

ExprResult _finite(num v) => v.isFinite
    ? ExprResult.ok(v)
    : const ExprResult.err('EXPR_OVERFLOW', 'Numeric result is not finite.');

ExprResult _numbers(List<Object?> args, {bool skipNull = false}) {
  final list = (args.length == 1 && args[0] is List) ? args[0] as List : args;
  final out = <num>[];
  for (final v in list) {
    if (v == null && skipNull) continue;
    if (!isNum(v))
      return ExprResult.err(
        'EXPR_TYPE_ERROR',
        'Arithmetic expects finite numbers, got ${v == null ? 'null' : v.runtimeType}.',
      );
    out.add(v as num);
  }
  return ExprResult.ok(out);
}

ExprResult _reduce(
  List<Object?> args,
  num Function(num, num) fn,
  num init, {
  bool skipNull = false,
}) {
  final n = _numbers(args, skipNull: skipNull);
  if (!n.ok) return n;
  num acc = init;
  for (final v in n.value as List<num>) {
    acc = fn(acc, v);
  }
  return _finite(acc);
}

ExprResult _apply(String op, List<Object?> a, Map<String, int> limits) {
  switch (op) {
    case 'and':
      return a.every(isBool)
          ? ExprResult.ok(a.every((x) => x == true))
          : const ExprResult.err('EXPR_TYPE_ERROR', 'and expects booleans.');
    case 'or':
      return a.every(isBool)
          ? ExprResult.ok(a.any((x) => x == true))
          : const ExprResult.err('EXPR_TYPE_ERROR', 'or expects booleans.');
    case 'not':
      return isBool(a[0])
          ? ExprResult.ok(!(a[0] as bool))
          : const ExprResult.err('EXPR_TYPE_ERROR', 'not expects a boolean.');
    case 'if':
      return isBool(a[0])
          ? ExprResult.ok(a[0] == true ? a[1] : a[2])
          : const ExprResult.err(
              'EXPR_TYPE_ERROR',
              'if expects a boolean condition.',
            );
    case 'coalesce':
      return ExprResult.ok(a.firstWhere((x) => x != null, orElse: () => null));
    case 'eq':
      return ExprResult.ok(deepEqual(a[0], a[1]));
    case 'neq':
      return ExprResult.ok(!deepEqual(a[0], a[1]));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      final x = a[0], y = a[1];
      bool cmp(num p, num q) => op == 'gt'
          ? p > q
          : op == 'gte'
          ? p >= q
          : op == 'lt'
          ? p < q
          : p <= q;
      bool cmps(String p, String q) => op == 'gt'
          ? p.compareTo(q) > 0
          : op == 'gte'
          ? p.compareTo(q) >= 0
          : op == 'lt'
          ? p.compareTo(q) < 0
          : p.compareTo(q) <= 0;
      if (isNum(x) && isNum(y)) return ExprResult.ok(cmp(x as num, y as num));
      if (isStr(x) && isStr(y))
        return ExprResult.ok(cmps(x as String, y as String));
      return const ExprResult.err(
        'EXPR_TYPE_ERROR',
        'Comparison expects two numbers or two strings.',
      );
    case 'isNull':
      return ExprResult.ok(a[0] == null);
    case 'isEmpty':
      final v = a[0];
      if (v == null) return const ExprResult.ok(true);
      if (v is String) return ExprResult.ok(v.isEmpty);
      if (v is List) return ExprResult.ok(v.isEmpty);
      if (v is Map) return ExprResult.ok(v.isEmpty);
      return const ExprResult.ok(false);
    case 'in':
      return a[1] is List
          ? ExprResult.ok((a[1] as List).any((v) => deepEqual(v, a[0])))
          : const ExprResult.err(
              'EXPR_TYPE_ERROR',
              'in expects (value, array).',
            );
    case 'contains':
      final c = a[0];
      if (isStr(c) && isStr(a[1]))
        return ExprResult.ok((c as String).contains(a[1] as String));
      if (c is List) return ExprResult.ok(c.any((v) => deepEqual(v, a[1])));
      return const ExprResult.err(
        'EXPR_TYPE_ERROR',
        'contains expects (string, string) or (array, value).',
      );
    case 'concat':
      var out = '';
      for (final v in a) {
        if (v == null) continue;
        if (!(isStr(v) || isNum(v) || isBool(v)))
          return const ExprResult.err(
            'EXPR_TYPE_ERROR',
            'concat expects strings/numbers/booleans.',
          );
        out += _str(v);
        if (out.length > limits['maxStringLength']!)
          return const ExprResult.err(
            'EXPR_LIMIT_EXCEEDED',
            'concat exceeded string budget.',
          );
      }
      return ExprResult.ok(out);
    case 'len':
      final v = a[0];
      if (isStr(v)) return ExprResult.ok((v as String).length);
      if (v is List)
        return v.length > limits['maxCollectionItems']!
            ? const ExprResult.err(
                'EXPR_LIMIT_EXCEEDED',
                'Collection too large.',
              )
            : ExprResult.ok(v.length);
      if (v == null) return const ExprResult.ok(0);
      return const ExprResult.err(
        'EXPR_TYPE_ERROR',
        'len expects string or array.',
      );
    case 'startsWith':
      return isStr(a[0]) && isStr(a[1])
          ? ExprResult.ok((a[0] as String).startsWith(a[1] as String))
          : const ExprResult.err(
              'EXPR_TYPE_ERROR',
              'startsWith expects strings.',
            );
    case 'endsWith':
      return isStr(a[0]) && isStr(a[1])
          ? ExprResult.ok((a[0] as String).endsWith(a[1] as String))
          : const ExprResult.err(
              'EXPR_TYPE_ERROR',
              'endsWith expects strings.',
            );
    case 'lower':
      return isStr(a[0])
          ? ExprResult.ok((a[0] as String).toLowerCase())
          : const ExprResult.err('EXPR_TYPE_ERROR', 'lower expects a string.');
    case 'upper':
      return isStr(a[0])
          ? ExprResult.ok((a[0] as String).toUpperCase())
          : const ExprResult.err('EXPR_TYPE_ERROR', 'upper expects a string.');
    case 'trim':
      return isStr(a[0])
          ? ExprResult.ok((a[0] as String).trim())
          : const ExprResult.err('EXPR_TYPE_ERROR', 'trim expects a string.');
    case 'add':
      return _reduce(a, (x, y) => x + y, 0);
    case 'mul':
      return _reduce(a, (x, y) => x * y, 1);
    case 'sub':
      final n = _numbers(a);
      if (!n.ok) return n;
      final vals = n.value as List<num>;
      if (vals.isEmpty) return const ExprResult.ok(0);
      num acc = vals[0];
      for (final v in vals.skip(1)) {
        acc -= v;
      }
      return _finite(acc);
    case 'div':
      if (!isNum(a[0]) || !isNum(a[1]))
        return const ExprResult.err('EXPR_TYPE_ERROR', 'div expects numbers.');
      if (a[1] == 0)
        return const ExprResult.err(
          'EXPR_DIVISION_BY_ZERO',
          'Division by zero.',
        );
      return _finite((a[0] as num) / (a[1] as num));
    case 'mod':
      if (!isNum(a[0]) || !isNum(a[1]))
        return const ExprResult.err('EXPR_TYPE_ERROR', 'mod expects numbers.');
      if (a[1] == 0)
        return const ExprResult.err('EXPR_DIVISION_BY_ZERO', 'Modulo by zero.');
      return _finite((a[0] as num).remainder(a[1] as num));
    case 'abs':
      return isNum(a[0])
          ? ExprResult.ok((a[0] as num).abs())
          : const ExprResult.err('EXPR_TYPE_ERROR', 'abs expects a number.');
    case 'round':
      if (!isNum(a[0]))
        return const ExprResult.err(
          'EXPR_TYPE_ERROR',
          'round expects a number.',
        );
      final d = a.length > 1 ? a[1] : 0;
      if (!isNum(d) || (d as num) != d.roundToDouble() || d < 0 || d > 10)
        return const ExprResult.err(
          'EXPR_TYPE_ERROR',
          'round digits must be integer 0..10.',
        );
      return ExprResult.ok(roundHalfAway((a[0] as num).toDouble(), d.toInt()));
    case 'sum':
      return _reduce(a, (x, y) => x + y, 0, skipNull: true);
    case 'avg':
      final n = _numbers(a, skipNull: true);
      if (!n.ok) return n;
      final vals = n.value as List<num>;
      if (vals.isEmpty) return const ExprResult.ok(null);
      return _finite(vals.reduce((x, y) => x + y) / vals.length);
    case 'min':
    case 'max':
      final n = _numbers(a, skipNull: true);
      if (!n.ok) return n;
      final vals = n.value as List<num>;
      if (vals.isEmpty) return const ExprResult.ok(null);
      return ExprResult.ok(
        vals.reduce((x, y) => op == 'min' ? (x < y ? x : y) : (x > y ? x : y)),
      );
    case 'count':
      return a[0] is List
          ? ExprResult.ok((a[0] as List).length)
          : (a[0] == null
                ? const ExprResult.ok(0)
                : const ExprResult.err(
                    'EXPR_TYPE_ERROR',
                    'count expects an array.',
                  ));
    case 'toNumber':
      final v = a[0];
      if (v == null) return const ExprResult.ok(null);
      if (isNum(v)) return ExprResult.ok(v);
      if (isBool(v)) return ExprResult.ok(v == true ? 1 : 0);
      if (isStr(v) && (v as String).trim().isNotEmpty) {
        final f = double.tryParse(v);
        if (f != null && f.isFinite)
          return ExprResult.ok(
            f == f.roundToDouble() &&
                    !v.contains('.') &&
                    !v.toLowerCase().contains('e')
                ? f.toInt()
                : f,
          );
      }
      return const ExprResult.err(
        'EXPR_TYPE_ERROR',
        'toNumber cannot convert value.',
      );
    case 'toString':
      return ExprResult.ok(a[0] == null ? '' : _str(a[0]));
    case 'toBoolean':
      final v = a[0];
      if (isBool(v)) return ExprResult.ok(v);
      if (v == null) return const ExprResult.ok(false);
      if (isNum(v)) return ExprResult.ok(v != 0);
      if (isStr(v)) return ExprResult.ok((v as String).isNotEmpty);
      if (v is List) return ExprResult.ok(v.isNotEmpty);
      return const ExprResult.ok(true);
    case 'dateAddDays':
      final t = _isoDate(a[0]);
      if (t == null ||
          !isNum(a[1]) ||
          (a[1] as num) != (a[1] as num).roundToDouble())
        return const ExprResult.err(
          'EXPR_TYPE_ERROR',
          'dateAddDays expects (ISO date, integer days).',
        );
      final dt = DateTime.fromMillisecondsSinceEpoch(
        t + (a[1] as num).toInt() * 86400000,
        isUtc: true,
      );
      return ExprResult.ok(
        '${dt.year.toString().padLeft(4, '0')}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}',
      );
    case 'dateDiffDays':
      final x = _isoDate(a[0]), y = _isoDate(a[1]);
      if (x == null || y == null)
        return const ExprResult.err(
          'EXPR_TYPE_ERROR',
          'dateDiffDays expects ISO dates.',
        );
      return ExprResult.ok(((x - y) / 86400000).round());
  }
  return ExprResult.err('EXPR_UNKNOWN_OPERATOR', 'Unknown operator "$op".');
}

const Map<String, List<int>> operatorArity = {
  'and': [1, -1],
  'or': [1, -1],
  'not': [1, 1],
  'if': [3, 3],
  'coalesce': [1, -1],
  'eq': [2, 2],
  'neq': [2, 2],
  'gt': [2, 2],
  'gte': [2, 2],
  'lt': [2, 2],
  'lte': [2, 2],
  'isNull': [1, 1],
  'isEmpty': [1, 1],
  'in': [2, 2],
  'contains': [2, 2],
  'concat': [0, -1],
  'len': [1, 1],
  'startsWith': [2, 2],
  'endsWith': [2, 2],
  'lower': [1, 1],
  'upper': [1, 1],
  'trim': [1, 1],
  'add': [0, -1],
  'mul': [0, -1],
  'sub': [1, -1],
  'div': [2, 2],
  'mod': [2, 2],
  'abs': [1, 1],
  'round': [1, 2],
  'sum': [1, -1],
  'avg': [1, -1],
  'min': [1, -1],
  'max': [1, -1],
  'count': [1, 1],
  'toNumber': [1, 1],
  'toString': [1, 1],
  'toBoolean': [1, 1],
  'dateAddDays': [2, 2],
  'dateDiffDays': [2, 2],
};

ExprResult _resolveRef(
  String ref,
  Map<String, Object?> scope,
  Map<String, int> limits,
) {
  final parsed = parseRef(ref);
  if (parsed == null)
    return ExprResult.err(
      'EXPR_REFERENCE_INVALID',
      'Invalid reference "$ref".',
    );
  final kind = parsed.kind, path = parsed.path;
  switch (kind) {
    case 'field':
      final v = getPath(scope['values'], path);
      if (v is List &&
          path.contains('*') &&
          v.length > limits['maxCollectionItems']!)
        return const ExprResult.err(
          'EXPR_LIMIT_EXCEEDED',
          'Wildcard projection exceeded collection budget.',
        );
      return ExprResult.ok(v);
    case 'item':
      if (scope['rowPrefix'] == null)
        return ExprResult.err(
          'EXPR_SCOPE_ERROR',
          'item: reference "$ref" used outside a repeater row.',
        );
      return ExprResult.ok(
        getPath(scope['values'], '${scope['rowPrefix']}.$path'),
      );
    case 'parent':
      final full = scope['parentPrefix'] != null
          ? '${scope['parentPrefix']}.$path'
          : path;
      return ExprResult.ok(getPath(scope['values'], full));
    case 'index':
      if (scope['rowIndex'] == null)
        return const ExprResult.err(
          'EXPR_SCOPE_ERROR',
          'index reference used outside a repeater row.',
        );
      return ExprResult.ok(scope['rowIndex']);
    case 'context':
      return ExprResult.ok(getPath(scope['context'] ?? {}, path));
    case 'source':
      return ExprResult.ok((scope['sources'] as Map?)?[path]);
  }
  return ExprResult.err('EXPR_REFERENCE_INVALID', 'Invalid reference "$ref".');
}

({int nodes, int depth}) measureExpr(Map<String, dynamic> expr) {
  var nodes = 0, maxDepth = 0;
  void walk(Map<String, dynamic> e, int d) {
    nodes++;
    if (d > maxDepth) maxDepth = d;
    if (e.containsKey('op')) {
      for (final a in (e['args'] as List? ?? [])) {
        walk(a as Map<String, dynamic>, d + 1);
      }
    }
  }

  walk(expr, 1);
  return (nodes: nodes, depth: maxDepth);
}

ExprResult evaluate(Map<String, dynamic> expr, Map<String, Object?> scope) {
  final limits = {
    ...defaultLimits,
    ...(scope['limits'] as Map<String, int>? ?? {}),
  };
  final m = measureExpr(expr);
  if (m.nodes > limits['maxNodes']!)
    return ExprResult.err(
      'EXPR_LIMIT_EXCEEDED',
      'Expression has ${m.nodes} nodes (max ${limits['maxNodes']}).',
    );
  if (m.depth > limits['maxDepth']!)
    return ExprResult.err(
      'EXPR_LIMIT_EXCEEDED',
      'Expression depth ${m.depth} exceeds max ${limits['maxDepth']}.',
    );
  var budget = limits['maxNodes']! * 4;

  ExprResult evalNode(Map<String, dynamic> e, int d) {
    budget--;
    if (budget < 0)
      return const ExprResult.err(
        'EXPR_LIMIT_EXCEEDED',
        'Evaluation budget exhausted.',
      );
    if (d > limits['maxDepth']!)
      return const ExprResult.err(
        'EXPR_LIMIT_EXCEEDED',
        'Depth budget exceeded.',
      );
    if (e.containsKey('const')) return ExprResult.ok(e['const']);
    if (e.containsKey('ref'))
      return _resolveRef(e['ref'] as String, scope, limits);
    if (!e.containsKey('op'))
      return const ExprResult.err(
        'EXPR_REFERENCE_INVALID',
        'Malformed expression node.',
      );
    final op = e['op'] as String;
    final argsAst = (e['args'] as List? ?? []).cast<Map<String, dynamic>>();
    if (!operatorArity.containsKey(op))
      return ExprResult.err('EXPR_UNKNOWN_OPERATOR', 'Unknown operator "$op".');
    final arity = operatorArity[op]!;
    if (argsAst.length < arity[0] ||
        (arity[1] != -1 && argsAst.length > arity[1])) {
      return ExprResult.err(
        'EXPR_TYPE_ERROR',
        'Operator "$op" has wrong arity (${argsAst.length}).',
      );
    }
    if (op == 'and' || op == 'or') {
      for (final a in argsAst) {
        final r = evalNode(a, d + 1);
        if (!r.ok) return r;
        if (!isBool(r.value))
          return ExprResult.err('EXPR_TYPE_ERROR', '$op expects booleans.');
        if (op == 'and' && r.value == false) return const ExprResult.ok(false);
        if (op == 'or' && r.value == true) return const ExprResult.ok(true);
      }
      return ExprResult.ok(op == 'and');
    }
    if (op == 'if') {
      final c = evalNode(argsAst[0], d + 1);
      if (!c.ok) return c;
      if (!isBool(c.value))
        return const ExprResult.err(
          'EXPR_TYPE_ERROR',
          'if expects a boolean condition.',
        );
      return evalNode(c.value == true ? argsAst[1] : argsAst[2], d + 1);
    }
    if (op == 'coalesce') {
      for (final a in argsAst) {
        final r = evalNode(a, d + 1);
        if (!r.ok) return r;
        if (r.value != null) return ExprResult.ok(r.value);
      }
      return const ExprResult.ok(null);
    }
    final args = <Object?>[];
    for (final a in argsAst) {
      final r = evalNode(a, d + 1);
      if (!r.ok) return r;
      args.add(r.value);
    }
    return _apply(op, args, limits);
  }

  return evalNode(expr, 1);
}

ExprResult evaluateBoolean(
  Map<String, dynamic> expr,
  Map<String, Object?> scope,
) {
  final r = evaluate(expr, scope);
  if (!r.ok) return r;
  if (!isBool(r.value))
    return const ExprResult.err(
      'EXPR_TYPE_ERROR',
      'Condition must evaluate to a boolean.',
    );
  return r;
}
