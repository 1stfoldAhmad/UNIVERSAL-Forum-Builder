/// Server-equivalent effective state + validation — Dart port. Operates on the
/// compiled FormIR (shared cross-language contract). Mirrors packages/form-validation.
library;

import 'expr.dart';

String localize(Object? text, String locale, {String fallback = 'en'}) {
  if (text == null) return '';
  if (text is String) return text;
  if (text is Map) return (text[locale] ?? text[fallback] ?? (text.values.isNotEmpty ? text.values.first : '')) as String;
  return text.toString();
}

Map<String, dynamic> setIn(Map<String, dynamic> root, String path, Object? value) {
  final segments = path.split('.');
  Object? recur(Object? node, int i) {
    if (i == segments.length) return value;
    final seg = segments[i];
    if (RegExp(r'^\d+$').hasMatch(seg)) {
      final arr = node is List ? List<Object?>.from(node) : <Object?>[];
      final idx = int.parse(seg);
      while (arr.length <= idx) { arr.add(null); }
      arr[idx] = recur(arr[idx], i + 1);
      return arr;
    }
    final obj = node is Map ? Map<String, dynamic>.from(node) : <String, dynamic>{};
    obj[seg] = recur(obj[seg], i + 1);
    return obj;
  }
  return recur(root, 0) as Map<String, dynamic>;
}

class EffectiveState {
  final Map<String, bool> visibility = {}, required = {}, disabled = {}, readonly = {};
}

EffectiveState computeEffectiveState(Map<String, dynamic> ir, Map<String, dynamic> values,
    {Map<String, dynamic> context = const {}, Map<String, dynamic> sources = const {}}) {
  final state = EffectiveState();
  for (final f in (ir['fields'] as List)) {
    final id = f['id'] as String;
    state.visibility[id] = !(f['hidden'] == true);
    state.required[id] = f['required'] == true;
    state.disabled[id] = f['disabled'] == true;
    state.readonly[id] = f['readonly'] == true;
  }
  for (final c in (ir['conditions'] as List? ?? [])) {
    final r = evaluateBoolean((c['when'] as Map).cast<String, dynamic>(), {'values': values, 'context': context, 'sources': sources});
    if (!r.ok || r.value != true) continue;
    for (final eff in (c['effects'] as List? ?? [])) {
      final s = (eff['set'] as Map?) ?? {};
      final fid = eff['fieldId'] as String;
      if (s.containsKey('visible')) state.visibility[fid] = s['visible'] == true;
      if (s.containsKey('required')) state.required[fid] = s['required'] == true;
      if (s.containsKey('disabled')) state.disabled[fid] = s['disabled'] == true;
      if (s.containsKey('readonly')) state.readonly[fid] = s['readonly'] == true;
    }
  }
  return state;
}

class FieldInstance {
  final Map<String, dynamic> field;
  final String concreteKey;
  FieldInstance(this.field, this.concreteKey);
}

List<FieldInstance> expandFieldInstances(Map<String, dynamic> ir, Map<String, dynamic> values) {
  final out = <FieldInstance>[];
  final repeaters = <String, Map<String, dynamic>>{};
  for (final f in (ir['fields'] as List)) { if (f['type'] == 'repeater') repeaters[f['id'] as String] = (f as Map).cast<String, dynamic>(); }
  for (final raw in (ir['fields'] as List)) {
    final f = (raw as Map).cast<String, dynamic>();
    if (f['type'] == 'repeater' || f['type'] == 'group') out.add(FieldInstance(f, f['key'] as String));
    final repId = f['repeaterId'] as String?;
    if (repId == null) {
      if (f['type'] != 'repeater' && f['type'] != 'group') out.add(FieldInstance(f, f['key'] as String));
      continue;
    }
    final rep = repeaters[repId];
    if (rep == null) continue;
    final rows = getPath(values, rep['key'] as String);
    final n = rows is List ? rows.length : 0;
    for (var i = 0; i < n; i++) {
      out.add(FieldInstance(f, (f['key'] as String).replaceAll('[]', '.$i')));
    }
  }
  return out;
}

bool isEmptyValue(Object? v) {
  if (v == null) return true;
  if (v is String) return v.isEmpty;
  if (v is List) return v.isEmpty;
  if (v is Map) return v.isEmpty;
  return false;
}

final Map<String, RegExp> formatPatterns = {
  'email': RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  'url': RegExp(r'^https?://[^\s/$.?#].[^\s]*$', caseSensitive: false),
  'phone': RegExp(r'^\+?[0-9\s\-().]{6,20}$'),
  'date': RegExp(r'^\d{4}-\d{2}-\d{2}$'),
  'time': RegExp(r'^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'),
  'uuid': RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false),
  'color': RegExp(r'#([0-9a-f]{3}|[0-9a-f]{6})$', caseSensitive: false),
};

Map<String, dynamic> _issue(String code, String message, String path, [String? fieldId]) =>
    {'code': code, 'message': message, 'path': path, 'severity': 'error', 'source': 'field', if (fieldId != null) 'fieldId': fieldId};

List<Map<String, dynamic>> validateValues(Map<String, dynamic> ir, Map<String, dynamic> values, EffectiveState state,
    {String phase = 'submit', String locale = 'en'}) {
  final issues = <Map<String, dynamic>>[];
  for (final inst in expandFieldInstances(ir, values)) {
    final f = inst.field;
    final id = f['id'] as String;
    if (state.visibility[id] == false) continue;
    final v = getPath(values, inst.concreteKey);
    final required = state.required[id] == true;
    final label = localize(f['label'], locale);
    if (required && isEmptyValue(v)) { issues.add(_issue('REQUIRED', '$label is required.', inst.concreteKey, id)); continue; }
    if (isEmptyValue(v)) continue;
    final val = (f['validation'] as Map?) ?? {};
    final vt = f['valueType'] as String? ?? 'string';
    if (vt == 'integer' && !(v is int)) issues.add(_issue('TYPE', '$label must be an integer.', inst.concreteKey, id));
    if (vt == 'number' && v is! num) issues.add(_issue('TYPE', '$label must be a number.', inst.concreteKey, id));
    if (v is num) {
      if (val['min'] != null && v < (val['min'] as num)) issues.add(_issue('MIN', '$label must be ≥ ${val['min']}.', inst.concreteKey, id));
      if (val['max'] != null && v > (val['max'] as num)) issues.add(_issue('MAX', '$label must be ≤ ${val['max']}.', inst.concreteKey, id));
    }
    if (v is String) {
      if (val['minLength'] != null && v.length < (val['minLength'] as num)) issues.add(_issue('MIN_LENGTH', '$label is too short.', inst.concreteKey, id));
      if (val['maxLength'] != null && v.length > (val['maxLength'] as num)) issues.add(_issue('MAX_LENGTH', '$label is too long.', inst.concreteKey, id));
      if (val['pattern'] != null) {
        final p = val['pattern'] as String;
        if (p.length <= 1000 && !RegExp(p).hasMatch(v)) issues.add(_issue('PATTERN', '$label has an invalid format.', inst.concreteKey, id));
      }
      if (val['format'] != null && formatPatterns.containsKey(val['format'])) {
        if (!formatPatterns[val['format']]!.hasMatch(v)) issues.add(_issue('FORMAT', '$label has an invalid format.', inst.concreteKey, id));
      }
    }
    if (v is List) {
      if (val['minItems'] != null && v.length < (val['minItems'] as num)) issues.add(_issue('MIN_ITEMS', '$label needs more entries.', inst.concreteKey, id));
      if (val['maxItems'] != null && v.length > (val['maxItems'] as num)) issues.add(_issue('MAX_ITEMS', '$label has too many entries.', inst.concreteKey, id));
    }
  }
  for (final rule in (ir['crossFieldRules'] as List? ?? [])) {
    final r = evaluateBoolean((rule['expr'] as Map).cast<String, dynamic>(), {'values': values});
    if (r.ok && r.value == false) {
      issues.add(_issue('CROSS_FIELD', localize(rule['message'], locale), (rule['path'] as String?) ?? ''));
    }
  }
  return issues;
}
