/// Native upload lifecycle + single-active-submission guarantees (mission §3.4,
/// §4.5) and the shared cross-language asset conformance fixture (§3.2, §10).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vds_form_flutter/vds_form_flutter.dart';

String fixturesDir() =>
    Platform.environment['VDS_CONFORMANCE_FIXTURES'] ?? '../../packages/form-conformance/fixtures';

Map<String, dynamic> uploadIr({bool multiple = true, List<String>? accept, int? maxSize}) => {
      'formId': 'test:uploads',
      'specVersion': '1.0.0',
      'fields': [
        {
          'id': 'doc', 'key': 'doc', 'type': 'file', 'label': 'Document',
          'valueType': multiple ? 'asset[]' : 'asset',
          'validation': {
            if (multiple) 'multiple': true,
            if (accept != null) 'accept': accept,
            if (maxSize != null) 'maxSizeBytes': maxSize,
          },
        },
        {'id': 'note', 'key': 'note', 'type': 'text', 'label': 'Note', 'valueType': 'string'},
      ],
      'layout': {'type': 'section', 'fieldRefs': ['doc', 'note']},
      'formulas': [], 'conditions': [],
    };

class FakeUpload implements UploadAdapter {
  final List<String> calls = [];
  final Set<String> failFor;
  final bool ignoreCancel;
  final Completer<void>? gate;
  int seq = 0;
  FakeUpload({this.failFor = const {}, this.ignoreCancel = false, this.gate});

  @override
  Future<Map<String, dynamic>> upload(String fieldPath, String name, List<int> bytes, String mimeType,
      {void Function(double)? onProgress, UploadCancellation? cancellation}) async {
    calls.add(name);
    onProgress?.call(0.5);
    if (gate != null) await gate!.future;
    if (failFor.contains(name)) throw Exception('boom');
    if (cancellation?.isCancelled == true && !ignoreCancel) throw Exception('UPLOAD_CANCELLED');
    seq++;
    return {'assetRef': 'ref-$seq', 'name': name, 'mimeType': mimeType, 'sizeBytes': bytes.length};
  }
}

class FakePicker implements FilePickerAdapter {
  final List<PickedFile> files;
  FakePicker(this.files);
  @override
  Future<List<PickedFile>> pick({required bool image, required bool multiple, List<String>? accept}) async => files;
}

class MemoryDrafts implements DraftAdapter {
  final Map<String, Map<String, dynamic>> store = {};
  @override
  Future<void> save(String formId, Map<String, dynamic> values) async { store[formId] = Map.from(values); }
  @override
  Future<Map<String, dynamic>?> load(String formId) async => store[formId];
  @override
  Future<void> clear(String formId) async { store.remove(formId); }
}

PickedFile pf(String name, {int size = 3, String? mime = 'application/pdf', String? id}) =>
    PickedFile(name: name, bytes: List.filled(size, 65), mimeType: mime, id: id);

void main() {
  group('shared asset conformance fixture', () {
    test('Dart matches every canonical case', () {
      final suite = jsonDecode(File('${fixturesDir()}/asset-upload.json').readAsStringSync()) as Map<String, dynamic>;
      final failures = <String>[];
      for (final c in (suite['cases'] as List)) {
        final m = (c as Map).cast<String, dynamic>();
        final expect = (m['expect'] as Map).cast<String, dynamic>();
        final gotType = assetTypeAllowed(
            name: m['name'] as String?, mimeType: m['mimeType'] as String?, accept: (m['accept'] as List).cast<String>());
        final gotSize = assetSizeAllowed(m['sizeBytes'], m['maxSizeBytes'] as num?);
        if (gotType != expect['typeAllowed']) failures.add('${m['id']}: type $gotType != ${expect['typeAllowed']}');
        if (gotSize != expect['sizeAllowed']) failures.add('${m['id']}: size $gotSize != ${expect['sizeAllowed']}');
      }
      expect(failures, isEmpty, reason: failures.join(' | '));
    });

    test('extension helpers are canonical', () {
      expect(fileExtension('photo.JPG'), 'jpeg');
      expect(normalizeMimeType('image/jpg'), 'image/jpeg');
      expect(assetTypeAllowed(name: 'p.jpg', mimeType: 'image/jpeg', accept: ['.jpg']), isTrue);
      expect(assetTypeAllowed(name: 'p.png', mimeType: 'image/png', accept: ['.jpg']), isFalse);
    });
  });

  group('single active submission (§4.5)', () {
    test('two rapid submit() calls execute the transport ONCE', () async {
      final gate = Completer<Map<String, dynamic>>();
      var executions = 0;
      final keys = <String>[];
      final c = FormController(
        ir: uploadIr(),
        transport: (formId, values, key) {
          executions++; keys.add(key);
          return gate.future;
        },
      );
      c.initialize();

      final a = c.submit();
      final b = c.submit();
      expect(c.isSubmitting, isTrue);
      expect(executions, 1);

      gate.complete({'status': 'succeeded'});
      final ra = await a;
      final rb = await b;
      expect(executions, 1, reason: 'a second tap must not start a second transport execution');
      expect(ra['status'], 'succeeded');
      expect(rb['status'], 'succeeded');
      expect(keys.length, 1);
      expect(c.isSubmitting, isFalse);
      expect(c.status, 'succeeded');
    });

    test('an unresolved attempt reuses its key; an edited payload gets a new one', () async {
      final keys = <String>[];
      var fail = true;
      final c = FormController(
        ir: uploadIr(),
        transport: (formId, values, key) async {
          keys.add(key);
          if (fail) throw Exception('network down');
          return {'status': 'succeeded'};
        },
      );
      c.initialize();
      await c.submit();
      expect(c.status, 'failed');
      await c.submit();
      expect(keys[0], keys[1], reason: 'same unresolved payload must replay the same idempotency key');

      c.setFieldValue('note', 'edited');
      fail = false;
      await c.submit();
      expect(keys[2] != keys[1], isTrue, reason: 'an edited payload must not reuse the old key');
    });

    test('a definitive server verdict resolves the attempt (new key next time)', () async {
      final keys = <String>[];
      final c = FormController(
        ir: uploadIr(),
        transport: (formId, values, key) async { keys.add(key); return {'status': 'business-rejected', 'message': 'no'}; },
      );
      c.initialize();
      await c.submit();
      await c.submit();
      expect(keys[0] != keys[1], isTrue);
    });

    test('server validation errors are surfaced and status is failed', () async {
      final c = FormController(
        ir: uploadIr(),
        transport: (f, v, k) async => {'status': 'server-validation-failed', 'issues': [
          {'path': 'note', 'code': 'REQUIRED', 'message': 'Required', 'severity': 'error'},
        ]},
      );
      c.initialize();
      final r = await c.submit();
      expect(r['status'], 'server-validation-failed');
      expect(c.errorsFor('note'), isNotEmpty);
      expect(c.isSubmitting, isFalse);
    });

    test('no transport yields config-error, not a silent success', () async {
      final c = FormController(ir: uploadIr());
      c.initialize();
      final r = await c.submit();
      expect(r['status'], 'config-error');
      expect(r['code'], 'NO_TRANSPORT');
    });
  });

  group('upload lifecycle (§3.1–3.4)', () {
    test('partial success is preserved when a later file fails', () async {
      final up = FakeUpload(failFor: {'bad.pdf'});
      final c = FormController(ir: uploadIr(), uploads: up);
      c.initialize();
      final r = await c.uploadFiles('doc', [pf('ok.pdf'), pf('bad.pdf'), pf('ok2.pdf')]);
      expect(r.uploaded.length, 2);
      expect(r.failures.single.code, 'UPLOAD_FAILED');
      expect((c.fieldValue('doc') as List).length, 2);
    });

    test('canonical constraints reject oversized and wrong-type files', () async {
      final up = FakeUpload();
      final c = FormController(ir: uploadIr(accept: ['.jpg'], maxSize: 5), uploads: up);
      c.initialize();
      final r = await c.uploadFiles('doc', [pf('big.jpg', size: 9, mime: 'image/jpeg'), pf('a.png', mime: 'image/png'), pf('ok.jpg', mime: 'image/jpeg')]);
      expect(r.failures.map((f) => f.code).toList(), ['ASSET_TOO_LARGE', 'ASSET_TYPE_REJECTED']);
      expect(r.uploaded.length, 1);
    });

    test('.jpg is accepted against a .jpg accept token (original defect)', () async {
      final up = FakeUpload();
      final c = FormController(ir: uploadIr(accept: ['.jpg']), uploads: up);
      c.initialize();
      final r = await c.uploadFiles('doc', [pf('photo.jpg', mime: 'image/jpeg')]);
      expect(r.failures, isEmpty);
      expect(up.calls, ['photo.jpg']);
    });

    test('same reliable identity is not uploaded twice; distinct same-name files are kept', () async {
      final up = FakeUpload();
      final c = FormController(ir: uploadIr(), uploads: up);
      c.initialize();
      await c.uploadFiles('doc', [pf('a.pdf', id: 'n1')]);
      await c.uploadFiles('doc', [pf('a.pdf', id: 'n1')]);
      expect(up.calls.length, 1);
      // No reliable identity on these two: both must be preserved.
      await c.uploadFiles('doc', [pf('same.pdf'), pf('same.pdf')]);
      expect((c.fieldValue('doc') as List).length, 3);
    });

    test('cancelling mid-transfer keeps committed refs and never commits the cancelled one', () async {
      final gate = Completer<void>();
      final up = FakeUpload(gate: gate);
      final c = FormController(ir: uploadIr(), uploads: up);
      c.initialize();
      await c.uploadFiles('doc', [pf('first.pdf')]);
      final pending = c.uploadFiles('doc', [pf('second.pdf')]);
      c.cancelUpload('doc');
      gate.complete();
      final r = await pending;
      expect(r.cancelled, isTrue);
      expect((c.fieldValue('doc') as List).length, 1, reason: 'the cancelled upload must not be committed');
      expect(((c.fieldValue('doc') as List).first as Map)['name'], 'first.pdf');
    });

    test('a provider that ignores cancellation still cannot commit', () async {
      final gate = Completer<void>();
      final up = FakeUpload(gate: gate, ignoreCancel: true);
      final c = FormController(ir: uploadIr(), uploads: up);
      c.initialize();
      final pending = c.uploadFiles('doc', [pf('a.pdf')]);
      c.cancelUpload('doc');
      gate.complete();
      final r = await pending;
      expect(r.cancelled, isTrue);
      expect(c.fieldValue('doc'), isNull);
    });

    test('no upload adapter reports UPLOAD_PROVIDER_MISSING', () async {
      final c = FormController(ir: uploadIr());
      c.initialize();
      final r = await c.uploadFiles('doc', [pf('a.pdf')]);
      expect(r.failures.single.code, 'UPLOAD_PROVIDER_MISSING');
    });

    test('single-value field rejects extra files with MULTIPLE_NOT_ALLOWED', () async {
      final up = FakeUpload();
      final c = FormController(ir: uploadIr(multiple: false), uploads: up);
      c.initialize();
      final r = await c.uploadFiles('doc', [pf('a.pdf'), pf('b.pdf')]);
      expect(r.failures.single.code, 'MULTIPLE_NOT_ALLOWED');
      expect(c.fieldValue('doc'), isA<Map>());
    });

    test('the injected picker feeds the upload pipeline', () async {
      final up = FakeUpload();
      final c = FormController(ir: uploadIr(), uploads: up, picker: FakePicker([pf('picked.pdf')]));
      c.initialize();
      final r = await c.pickAndUpload('doc');
      expect(r.uploaded.length, 1);
      expect(up.calls, ['picked.pdf']);
      expect(c.uploadStateFor('doc').busy, isFalse);
    });

    test('pick without a picker adapter fails loudly', () async {
      final c = FormController(ir: uploadIr(), uploads: FakeUpload());
      c.initialize();
      final r = await c.pickAndUpload('doc');
      expect(r.failures.single.code, 'UPLOAD_PROVIDER_MISSING');
    });

    test('dispose cancels in-flight uploads and stops notifications', () async {
      final gate = Completer<void>();
      final up = FakeUpload(gate: gate);
      final c = FormController(ir: uploadIr(), uploads: up);
      c.initialize();
      var notifications = 0;
      c.addListener(() => notifications++);
      final pending = c.uploadFiles('doc', [pf('a.pdf')]);
      c.dispose();
      final before = notifications;
      gate.complete();
      final r = await pending;
      expect(r.cancelled, isTrue);
      expect(c.isDisposed, isTrue);
      expect(notifications, before, reason: 'no notifications after dispose');
    });
  });

  group('drafts (§4.6)', () {
    test('save, restore and clear round-trip through the injected adapter', () async {
      final drafts = MemoryDrafts();
      final c = FormController(ir: uploadIr(), drafts: drafts);
      c.initialize();
      c.setFieldValue('note', 'hello');
      await c.saveDraft();
      expect(c.draftStatus, 'saved');

      final c2 = FormController(ir: uploadIr(), drafts: drafts);
      c2.initialize();
      expect(await c2.restoreDraft(), isTrue);
      expect(c2.fieldValue('note'), 'hello');
      expect(c2.draftStatus, 'restored');

      await c2.clearDraft();
      expect(c2.draftStatus, 'cleared');
      final c3 = FormController(ir: uploadIr(), drafts: drafts);
      c3.initialize();
      expect(await c3.restoreDraft(), isFalse);
      expect(c3.draftStatus, 'empty');
    });

    test('without an adapter draft status is unavailable, never a fake success', () async {
      final c = FormController(ir: uploadIr());
      c.initialize();
      await c.saveDraft();
      expect(c.draftStatus, 'unavailable');
    });
  });
}
