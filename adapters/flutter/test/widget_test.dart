import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vds_form_flutter/vds_form_flutter.dart';

Map<String, dynamic> loadIr(String name) {
  final base = Platform.environment['VDS_IR_FIXTURES'] ?? '../../execution-adapters/laravel/tests/fixtures/ir';
  return jsonDecode(File('$base/$name.ir.json').readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  testWidgets('renders fields, accepts input and submits via transport', (tester) async {
    var submitted = false;
    final c = FormController(
      ir: loadIr('customer-registration'),
      transport: (formId, values, key) async { submitted = true; return {'status': 'succeeded'}; },
    );
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: VdsForm(controller: c))));

    expect(find.byKey(const Key('vds-input-customer.name')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('vds-input-customer.name')), 'Ada Lovelace');
    await tester.enterText(find.byKey(const Key('vds-input-customer.email')), 'ada@example.com');
    await tester.tap(find.byKey(const Key('vds-input-customer.consent')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('vds-submit')));
    await tester.pumpAndSettle();

    expect(submitted, true);
    expect(find.text('Submitted successfully.'), findsOneWidget);
  });

  testWidgets('shows validation errors when required fields are empty', (tester) async {
    final c = FormController(ir: loadIr('customer-registration'));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: VdsForm(controller: c))));
    await tester.tap(find.byKey(const Key('vds-submit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vds-error-customer.name')), findsOneWidget);
  });
}
