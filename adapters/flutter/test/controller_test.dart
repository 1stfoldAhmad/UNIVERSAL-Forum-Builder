import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vds_form_flutter/vds_form_flutter.dart';

Map<String, dynamic> loadIr(String name) {
  final base =
      Platform.environment['VDS_IR_FIXTURES'] ??
      '../../execution-adapters/laravel/tests/fixtures/ir';
  return jsonDecode(File('$base/$name.ir.json').readAsStringSync())
      as Map<String, dynamic>;
}

void main() {
  test('formulas compute row-scoped and global totals (invoice)', () {
    final c = FormController(
      ir: loadIr('invoice'),
      initialValues: {
        'items': [
          {'description': 'A', 'qty': 2, 'price': 5},
          {'description': 'B', 'qty': 3, 'price': 4},
        ],
      },
    );
    c.initialize();
    expect(c.fieldValue('items.0.lineTotal'), 10);
    expect(c.fieldValue('subtotal'), 22);
    expect(c.fieldValue('total'), isNotNull);
  });

  test('conditions toggle visibility/required (registration)', () {
    final c = FormController(ir: loadIr('customer-registration'));
    c.initialize();
    expect(c.state.visibility['companyName'], false);
    c.setFieldValue('customer.type', 'business');
    expect(c.state.visibility['companyName'], true);
    expect(c.state.required['companyName'], true);
  });

  test('repeaters add/remove rows', () {
    final c = FormController(ir: loadIr('invoice'));
    c.initialize();
    final before = (c.fieldValue('items') as List).length;
    c.addRepeaterItem('items');
    expect((c.fieldValue('items') as List).length, before + 1);
    final rowId = c.repeaterRows['items']!.last;
    c.removeRepeaterItem('items', rowId);
    expect((c.fieldValue('items') as List).length, before);
  });

  test('validation reports required fields and submit blocks', () async {
    final c = FormController(ir: loadIr('customer-registration'));
    c.initialize();
    final issues = c.validate();
    expect(issues.any((i) => i['code'] == 'REQUIRED'), true);
    final result = await c.submit();
    expect(result['status'], 'server-validation-failed');
  });

  test(
    'concurrent submit calls execute transport only once and retry keeps the key',
    () async {
      var calls = 0;
      final keys = <String>[];
      final gate = Completer<Map<String, dynamic>>();
      final c = FormController(
        ir: loadIr('customer-registration'),
        initialValues: {
          'customer': {
            'name': 'Ada Lovelace',
            'email': 'ada@example.com',
            'type': 'individual',
            'consent': true,
          },
        },
        transport: (formId, values, key) {
          calls++;
          keys.add(key);
          return calls == 1
              ? gate.future
              : Future.value({'status': 'succeeded'});
        },
      );
      c.initialize();
      final first = c.submit();
      await Future<void>.delayed(Duration.zero);
      final second = await c.submit();
      expect(second['code'], 'SUBMISSION_IN_PROGRESS');
      expect(calls, 1);
      gate.complete({'status': 'business-rejected', 'message': 'retryable'});
      await first;
      await c.submit();
      expect(calls, 2);
      expect(keys[1], keys[0]);
    },
  );

  test('submit delegates to the injected trusted transport', () async {
    Map<String, dynamic>? sent;
    final c = FormController(
      ir: loadIr('customer-registration'),
      initialValues: {
        'customer': {
          'name': 'Ada Lovelace',
          'email': 'ada@example.com',
          'type': 'individual',
          'consent': true,
        },
      },
      transport: (formId, values, key) async {
        sent = values;
        return {'status': 'succeeded'};
      },
    );
    c.initialize();
    final result = await c.submit();
    expect(result['status'], 'succeeded');
    expect(sent, isNotNull);
    expect(c.status, 'succeeded');
  });
}
