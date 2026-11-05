/// Headless form controller — Dart port of @vds-form/runtime. Conditions,
/// formulas, repeaters, validation, multi-step. Submission is delegated to an
/// injected trusted transport (the client never executes business operations).
library;

import 'package:flutter/foundation.dart';

import 'assets.dart';
import 'expr.dart';
import 'validation.dart';

typedef SubmissionTransport = Future<Map<String, dynamic>> Function(
    String formId, Map<String, dynamic> values, String idempotencyKey);

abstract class DraftAdapter {
  Future<void> save(String formId, Map<String, dynamic> values);
  Future<Map<String, dynamic>?> load(String formId);
  Future<void> clear(String formId);
}

/// A file selected by the host platform (document picker, image picker, camera).
class PickedFile {
  final String name;
  final List<int> bytes;
  final String? mimeType;
  final String? id;
  final String? localUri;
  const PickedFile({required this.name, required this.bytes, this.mimeType, this.id, this.localUri});
  int get size => bytes.length;
}

/// Host-injected file/image selection. The renderer never bundles a picker
/// plugin; without this adapter the file controls are disabled and the
/// capability manifest reports `requiresHostAdapter`.
abstract class FilePickerAdapter {
  Future<List<PickedFile>> pick({required bool image, required bool multiple, List<String>? accept});
}

/// Host-injected camera capture. Separate from the picker so camera support is
/// only advertised when a real capture adapter exists.
abstract class CameraAdapter {
  Future<PickedFile?> capture({List<String>? accept});
}

/// Cooperative cancellation token for uploads.
class UploadCancellation {
  bool _cancelled = false;
  bool get isCancelled => _cancelled;
  void cancel() { _cancelled = true; }
}

/// Host-injected barcode/QR scanner. Without it the barcode control is disabled
/// and the manifest reports `requiresHostAdapter`.
abstract class BarcodeAdapter {
  Future<String?> scan();
}

abstract class UploadAdapter {
  Future<Map<String, dynamic>> upload(
    String fieldPath,
    String name,
    List<int> bytes,
    String mimeType, {
    void Function(double fraction)? onProgress,
    UploadCancellation? cancellation,
  });
}

/// Outcome of one file in an upload batch.
class UploadFailure {
  final String name;
  final String code;
  final String message;
  const UploadFailure(this.name, this.code, this.message);
}

class UploadBatchResult {
  final List<Map<String, dynamic>> uploaded;
  final List<UploadFailure> failures;
  final bool cancelled;
  const UploadBatchResult(this.uploaded, this.failures, this.cancelled);
}

/// Per-field upload UI state (progress / failures / in-flight cancellation).
class UploadState {
  final bool busy;
  final double fraction;
  final String? fileName;
  final List<UploadFailure> failures;
  const UploadState({this.busy = false, this.fraction = 0, this.fileName, this.failures = const []});
}

class FormController extends ChangeNotifier {
  final Map<String, dynamic> ir;
  final SubmissionTransport? transport;
  final DraftAdapter? drafts;
  final UploadAdapter? uploads;
  final FilePickerAdapter? picker;
  final CameraAdapter? camera;
  final BarcodeAdapter? barcode;
  String locale;

  Map<String, dynamic> values = {};
  EffectiveState state = EffectiveState();
  List<Map<String, dynamic>> issues = [];
  final Map<String, List<String>> repeaterRows = {};
  int stepIndex = 0;
  String status = 'idle';
  String? statusMessage;
  int _rowSeq = 0;

  /// Single active submission: concurrent submit() calls await the SAME attempt
  /// instead of starting a second transport execution.
  Future<Map<String, dynamic>>? _inFlight;
  String? _attemptKey;
  String? _attemptFingerprint;
  bool _disposed = false;
  bool get isSubmitting => _inFlight != null;
  bool get isDisposed => _disposed;

  final Map<String, UploadState> uploadStates = {};
  final Map<String, UploadCancellation> _uploadCancellations = {};
  final Set<String> _seenUploadIdentities = {};
  String draftStatus = 'idle';
  String? draftMessage;

  FormController({required this.ir, Map<String, dynamic>? initialValues, this.transport, this.drafts, this.uploads, this.picker, this.camera, this.barcode, String? locale})
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

  /// Stable fingerprint of the payload for idempotency-key reuse decisions.
  String _fingerprint() {
    final keys = values.keys.toList()..sort();
    final buf = StringBuffer();
    for (final k in keys) {
      buf.write(k);
      buf.write('=');
      buf.write(_stable(values[k]));
      buf.write(';');
    }
    return buf.toString();
  }

  String _stable(Object? v) {
    if (v is Map) {
      final keys = v.keys.map((e) => e.toString()).toList()..sort();
      return '{${keys.map((k) => '$k:${_stable(v[k])}').join(',')}}';
    }
    if (v is List) return '[${v.map(_stable).join(',')}]';
    return '${v ?? 'null'}';
  }

  /// A submission attempt is "unresolved" when the transport failed without a
  /// definitive server verdict (network/timeout). Only then is the key reused,
  /// and only while the payload is unchanged.
  Future<Map<String, dynamic>> submit() async {
    if (_disposed) return {'status': 'config-error', 'code': 'DISPOSED'};
    // One active attempt: a second rapid tap awaits the first, never re-executes.
    final active = _inFlight;
    if (active != null) return active;

    final found = validate();
    if (found.any((i) => i['severity'] == 'error')) {
      status = 'invalid'; statusMessage = 'Please correct the errors below.'; _notify();
      return {'status': 'server-validation-failed', 'issues': found};
    }
    if (transport == null) {
      status = 'failed'; statusMessage = 'No submission transport configured.'; _notify();
      return {'status': 'config-error', 'code': 'NO_TRANSPORT'};
    }

    final fp = _fingerprint();
    // Reuse the key only for an unresolved attempt with an UNCHANGED payload.
    final key = (_attemptKey != null && _attemptFingerprint == fp)
        ? _attemptKey!
        : 'flutter-${DateTime.now().millisecondsSinceEpoch}-${_rowSeq++}';
    _attemptKey = key;
    _attemptFingerprint = fp;

    status = 'submitting'; _notify();
    final run = _runSubmission(key);
    _inFlight = run;
    try {
      return await run;
    } finally {
      _inFlight = null;
    }
  }

  Future<Map<String, dynamic>> _runSubmission(String key) async {
    try {
      final result = await transport!(ir['formId'] as String, values, key);
      if (_disposed) return result;
      final st = result['status'] as String?;
      // A definitive server verdict resolves the attempt: the next submission
      // is a new attempt and must use a new key.
      _attemptKey = null; _attemptFingerprint = null;
      status = st == 'succeeded' ? 'succeeded' : 'failed';
      statusMessage = st == 'succeeded' ? 'Submitted successfully.' : (result['message'] as String? ?? st ?? 'failed');
      if (st == 'server-validation-failed' && result['issues'] is List) {
        issues = List<Map<String, dynamic>>.from((result['issues'] as List).map((e) => (e as Map).cast<String, dynamic>()));
      }
      _notify();
      return result;
    } catch (e) {
      // Unresolved: keep the key so a retry of the SAME payload replays safely.
      if (_disposed) return {'status': 'config-error', 'code': 'DISPOSED'};
      status = 'failed'; statusMessage = e.toString(); _notify();
      return {'status': 'config-error', 'message': e.toString()};
    }
  }

  void _notify() { if (!_disposed) notifyListeners(); }

  // ---------------------------------------------------------------- uploads

  /// Shared upload-batch semantics (mirrors @vds-form/runtime uploadAssetBatch):
  /// per-file commit, partial-success preservation, canonical constraints,
  /// reliable-identity de-duplication, cooperative cancellation.
  Future<UploadBatchResult> uploadFiles(String path, List<PickedFile> files, {String source = 'picker'}) async {
    final field = _fieldForPath(path);
    final v = (field?['validation'] as Map?) ?? const {};
    final multiple = v['multiple'] == true || field?['valueType'] == 'asset[]';
    final accept = (v['accept'] as List?)?.map((e) => e.toString()).toList();
    final maxSize = v['maxSizeBytes'] as num?;
    final failures = <UploadFailure>[];
    final uploaded = <Map<String, dynamic>>[];

    if (uploads == null) {
      return UploadBatchResult(uploaded, [UploadFailure(files.isNotEmpty ? files.first.name : '', 'UPLOAD_PROVIDER_MISSING', 'No upload adapter registered.')], false);
    }
    if (files.isEmpty) return UploadBatchResult(uploaded, failures, false);

    final batch = multiple ? files : files.take(1).toList();
    if (!multiple) {
      for (final extra in files.skip(1)) {
        failures.add(UploadFailure(extra.name, 'MULTIPLE_NOT_ALLOWED', 'Only one file is allowed.'));
      }
    }

    final existing = <Map<String, dynamic>>[];
    final cur = getPath(values, path);
    if (cur is List) {
      existing.addAll(cur.whereType<Map>().map((e) => e.cast<String, dynamic>()));
    } else if (cur is Map) {
      existing.add(cur.cast<String, dynamic>());
    }
    for (final r in existing) {
      final ref = r['assetRef'];
      if (ref is String && ref.isNotEmpty) _seenUploadIdentities.add('ref:$ref');
    }

    final cancel = UploadCancellation();
    _uploadCancellations[path] = cancel;
    uploadStates[path] = UploadState(busy: true, fileName: batch.first.name, failures: failures);
    _notify();

    for (final f in batch) {
      if (cancel.isCancelled || _disposed) break;
      if (!assetSizeAllowed(f.size, maxSize)) {
        failures.add(UploadFailure(f.name, 'ASSET_TOO_LARGE', 'File exceeds $maxSize bytes.'));
        continue;
      }
      if (!assetTypeAllowed(name: f.name, mimeType: f.mimeType, accept: accept)) {
        failures.add(UploadFailure(f.name, 'ASSET_TYPE_REJECTED', 'File type ${f.mimeType ?? f.name} is not allowed.'));
        continue;
      }
      final identity = uploadIdentity(id: f.id, localUri: f.localUri, name: f.name, size: f.size);
      if (identity != null && _seenUploadIdentities.contains(identity)) continue;

      try {
        final ref = await uploads!.upload(
          path, f.name, f.bytes, f.mimeType ?? 'application/octet-stream',
          onProgress: (fraction) {
            if (_disposed || cancel.isCancelled) return;
            uploadStates[path] = UploadState(busy: true, fraction: fraction, fileName: f.name, failures: failures);
            _notify();
          },
          cancellation: cancel,
        );
        // Never commit a cancelled/disposed batch, even if the adapter resolved.
        if (cancel.isCancelled || _disposed) break;
        if (identity != null) _seenUploadIdentities.add(identity);
        uploaded.add(ref);
        if (multiple) {
          final live = getPath(values, path);
          final arr = <Map<String, dynamic>>[];
          if (live is List) {
            arr.addAll(live.whereType<Map>().map((e) => e.cast<String, dynamic>()));
          } else if (live is Map) {
            arr.add(live.cast<String, dynamic>());
          }
          if (!arr.any((r) => r['assetRef'] == ref['assetRef'])) arr.add(ref);
          setFieldValue(path, arr);
        } else {
          setFieldValue(path, ref);
        }
      } catch (e) {
        if (cancel.isCancelled || _disposed) break;
        failures.add(UploadFailure(f.name, 'UPLOAD_FAILED', e.toString()));
      }
    }

    final cancelled = cancel.isCancelled;
    _uploadCancellations.remove(path);
    if (!_disposed) {
      uploadStates[path] = UploadState(busy: false, fraction: 1, failures: failures);
      _notify();
    }
    return UploadBatchResult(uploaded, failures, cancelled);
  }

  /// Opens the host picker (or camera) and uploads the selection.
  Future<UploadBatchResult> pickAndUpload(String path, {bool useCamera = false}) async {
    final field = _fieldForPath(path);
    if (field == null) return UploadBatchResult(const [], const [], false);
    final v = (field['validation'] as Map?) ?? const {};
    final multiple = v['multiple'] == true || field['valueType'] == 'asset[]';
    final accept = (v['accept'] as List?)?.map((e) => e.toString()).toList();
    final isImage = field['type'] == 'image';
    if (useCamera) {
      if (camera == null) {
        return UploadBatchResult(const [], [UploadFailure('', 'UPLOAD_PROVIDER_MISSING', 'No camera adapter registered.')], false);
      }
      final shot = await camera!.capture(accept: accept);
      if (_disposed || shot == null) return UploadBatchResult(const [], const [], shot == null);
      return uploadFiles(path, [shot], source: 'camera');
    }
    if (picker == null) {
      return UploadBatchResult(const [], [UploadFailure('', 'UPLOAD_PROVIDER_MISSING', 'No file picker adapter registered.')], false);
    }
    final picked = await picker!.pick(image: isImage, multiple: multiple, accept: accept);
    if (_disposed) return UploadBatchResult(const [], const [], true);
    return uploadFiles(path, picked);
  }

  void cancelUpload(String path) { _uploadCancellations[path]?.cancel(); }
  UploadState uploadStateFor(String path) => uploadStates[path] ?? const UploadState();

  Map<String, dynamic>? _fieldForPath(String path) {
    for (final f in (ir['fields'] as List)) {
      final m = (f as Map).cast<String, dynamic>();
      if (m['key'] == path) return m;
      final key = m['key'] as String?;
      if (key != null && key.contains('[]') && path.startsWith(key.split('[]').first)) return m;
    }
    return null;
  }

  // ----------------------------------------------------------------- drafts

  Future<void> saveDraft() async {
    if (drafts == null) { draftStatus = 'unavailable'; draftMessage = 'No draft adapter registered.'; _notify(); return; }
    try {
      await drafts!.save(ir['formId'] as String, values);
      if (_disposed) return;
      draftStatus = 'saved'; draftMessage = null; _notify();
    } catch (e) {
      if (_disposed) return;
      draftStatus = 'failed'; draftMessage = e.toString(); _notify();
    }
  }

  /// Restores a previously saved draft and recomputes derived state.
  Future<bool> restoreDraft() async {
    if (drafts == null) { draftStatus = 'unavailable'; _notify(); return false; }
    try {
      final saved = await drafts!.load(ir['formId'] as String);
      if (_disposed) return false;
      if (saved == null) { draftStatus = 'empty'; _notify(); return false; }
      values = Map<String, dynamic>.from(saved);
      _recompute();
      draftStatus = 'restored'; draftMessage = null; _notify();
      return true;
    } catch (e) {
      if (_disposed) return false;
      draftStatus = 'failed'; draftMessage = e.toString(); _notify();
      return false;
    }
  }

  Future<void> clearDraft() async {
    if (drafts == null) { draftStatus = 'unavailable'; _notify(); return; }
    try {
      await drafts!.clear(ir['formId'] as String);
      if (_disposed) return;
      draftStatus = 'cleared'; draftMessage = null; _notify();
    } catch (e) {
      if (_disposed) return;
      draftStatus = 'failed'; draftMessage = e.toString(); _notify();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    // Cancel in-flight uploads so a late adapter result cannot write into a
    // disposed controller.
    for (final c in _uploadCancellations.values) { c.cancel(); }
    _uploadCancellations.clear();
    super.dispose();
  }
}
