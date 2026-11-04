/// Headless form controller — Dart port of @vds-form/runtime. Conditions,
/// formulas, repeaters, validation, multi-step. Submission is delegated to an
/// injected trusted transport (the client never executes business operations).
library;

import 'package:flutter/foundation.dart';

import 'expr.dart';
import 'validation.dart';

typedef SubmissionTransport = Future<Map<String, dynamic>> Function(
    String formId, Map<String, dynamic> values, String idempotencyKey);

abstract class DraftAdapter {
  Future<void> save(String formId, Map<String, dynamic> values);
  Future<Map<String, dynamic>?> load(String formId);
  Future<void> clear(String formId);
}

abstract class UploadAdapter {
  Future<Map<String, dynamic>> upload(String fieldPath, String name, List<int> bytes, String mimeType);
}

class FormController extends ChangeNotifier {
  final Map<String, dynamic> ir;
  final SubmissionTransport? transport;
  final DraftAdapter? drafts;
  final UploadAdapter? uploads;
  String locale;

  Map<String, dynamic> values = {};
  EffectiveState state = EffectiveState();
  List<Map<String, dynamic>> issues = [];
  final Map<String, List<String>> repeaterRows = {};
  int stepIndex = 0;
  String status = 'idle';
  String? statusMessage;
  int _rowSeq = 0;

  FormController({required this.ir, Map<String, dynamic>? initialValues, this.transport, this.drafts, this.uploads, String? locale})
      : locale = locale ?? (ir['localization']?['defaultLocale'] as String? ?? 'en') {
    values = Map<String, dynamic>.from(initialValues ?? {});
  }

  void initialize() {
    for (final f in (ir['fields'] as List)) {
      if (f['parentId'] != null || f['repeaterId'] != null) continue;
      if (f.containsKey('defaultValue') && getPath(values, f['key'] as String) == null) {
        values = setIn(values, f['key'] as String, f['defaultValue']);
      }
    }
    for (final f in (ir['fields'] as List)) {
      if (f['type'] != 'repeater') continue;
      final rows = getPath(values, f['key'] as String);
      final list = rows is List ? List<Object?>.from(rows) : <Object?>[];
      final min = (f['validation']?['minItems'] ?? f['minItems'] ?? 0) as int;
      while (list.length < min) { list.add(<String, dynamic>{}); }
      values = setIn(values, f['key'] as String, list);
      repeaterRows[f['id'] as String] = List.generate(list.length, (i) => 'row-${_rowSeq++}');
    }
    _recompute();
  }

  void _recompute() {
    final formulas = (ir['formulas'] as List? ?? []);
    for (var pass = 0; pass <= formulas.length; pass++) {
      var changed = false;
      for (final formula in formulas) {
        final target = formula['target'] as String;
        if (target.contains('[]')) {
          final repKey = target.split('[]').first.replaceAll(RegExp(r'\.$'), '');
          final rows = getPath(values, repKey);
          final n = rows is List ? rows.length : 0;
          for (var i = 0; i < n; i++) {
            final concrete = target.replaceFirst('[]', '.$i');
            final r = evaluate((formula['expr'] as Map).cast<String, dynamic>(),
                {'values': values, 'rowPrefix': '$repKey.$i', 'rowIndex': i});
            if (r.ok && getPath(values, concrete) != r.value) { values = setIn(values, concrete, r.value); changed = true; }
          }
        } else {
          final r = evaluate((formula['expr'] as Map).cast<String, dynamic>(), {'values': values});
          if (r.ok && getPath(values, target) != r.value) { values = setIn(values, target, r.value); changed = true; }
        }
      }
      if (!changed) break;
    }
    state = computeEffectiveState(ir, values);
  }

  Object? fieldValue(String path) => getPath(values, path);

  void setFieldValue(String path, Object? value) {
    values = setIn(values, path, value);
    _recompute();
    notifyListeners();
  }

  void addRepeaterItem(String repeaterId) {
    final f = (ir['fields'] as List).firstWhere((x) => x['id'] == repeaterId) as Map;
    final rows = List<Object?>.from(getPath(values, f['key'] as String) as List? ?? []);
    rows.add(<String, dynamic>{});
    values = setIn(values, f['key'] as String, rows);
    repeaterRows[repeaterId] = [...(repeaterRows[repeaterId] ?? []), 'row-${_rowSeq++}'];
    _recompute();
    notifyListeners();
  }

  void removeRepeaterItem(String repeaterId, String rowId) {
    final f = (ir['fields'] as List).firstWhere((x) => x['id'] == repeaterId) as Map;
    final ids = repeaterRows[repeaterId] ?? [];
    final idx = ids.indexOf(rowId);
    if (idx < 0) return;
    final rows = List<Object?>.from(getPath(values, f['key'] as String) as List? ?? []);
    rows.removeAt(idx);
    values = setIn(values, f['key'] as String, rows);
    ids.removeAt(idx);
    _recompute();
    notifyListeners();
  }

  void moveRepeaterItem(String repeaterId, int from, int to) {
    final f = (ir['fields'] as List).firstWhere((x) => x['id'] == repeaterId) as Map;
    final rows = List<Object?>.from(getPath(values, f['key'] as String) as List? ?? []);
    final ids = repeaterRows[repeaterId] ?? [];
    if (from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
    final item = rows.removeAt(from); rows.insert(to, item);
    final id = ids.removeAt(from); ids.insert(to, id);
    values = setIn(values, f['key'] as String, rows);
    _recompute();
    notifyListeners();
  }

  List<Map<String, dynamic>> validate() {
    issues = validateValues(ir, values, state, locale: locale);
    notifyListeners();
    return issues;
  }

  List<Map<String, dynamic>> errorsFor(String path) =>
      issues.where((i) => i['path'] == path && i['severity'] == 'error').toList();

  Future<Map<String, dynamic>> submit() async {
    final found = validate();
    if (found.any((i) => i['severity'] == 'error')) {
      status = 'invalid'; statusMessage = 'Please correct the errors below.'; notifyListeners();
      return {'status': 'server-validation-failed', 'issues': found};
    }
    if (transport == null) {
      status = 'failed'; statusMessage = 'No submission transport configured.'; notifyListeners();
      return {'status': 'config-error', 'code': 'NO_TRANSPORT'};
    }
    status = 'submitting'; notifyListeners();
    final key = 'flutter-${DateTime.now().millisecondsSinceEpoch}-${_rowSeq++}';
    try {
      final result = await transport!(ir['formId'] as String, values, key);
      status = result['status'] == 'succeeded' ? 'succeeded' : 'failed';
      statusMessage = result['status'] == 'succeeded' ? 'Submitted successfully.' : (result['message'] as String? ?? result['status'] as String);
      if (result['status'] == 'server-validation-failed') issues = List<Map<String, dynamic>>.from(result['issues'] as List);
      notifyListeners();
      return result;
    } catch (e) {
      status = 'failed'; statusMessage = e.toString(); notifyListeners();
      return {'status': 'config-error', 'message': e.toString()};
    }
  }

  Future<void> saveDraft() async { if (drafts != null) await drafts!.save(ir['formId'] as String, values); }
}
