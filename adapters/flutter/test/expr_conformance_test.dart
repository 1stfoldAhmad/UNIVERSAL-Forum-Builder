import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vds_form_flutter/vds_form_flutter.dart';

void main() {
  final fixtures =
      Platform.environment['VDS_CONFORMANCE_FIXTURES'] ??
      '../../packages/form-conformance/fixtures';
  final suite =
      jsonDecode(File('$fixtures/expressions.json').readAsStringSync())
          as Map<String, dynamic>;
  final cases = (suite['cases'] as List).cast<Map<String, dynamic>>();

  test('vds.expr/1 cross-language conformance (${cases.length} cases)', () {
    final failures = <String>[];
    for (final c in cases) {
      final scope =
          (c['scope'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
      final result = evaluate(
        (c['expr'] as Map).cast<String, dynamic>(),
        scope,
      );
      final expect = (c['expect'] as Map).cast<String, dynamic>();
      if (expect['ok'] == true) {
        if (!result.ok) {
          failures.add('${c['id']}: expected ok, got ${result.code}');
          continue;
        }
        if (!deepEqual(result.value, expect['value'])) {
          failures.add(
            '${c['id']}: expected ${expect['value']}, got ${result.value}',
          );
        }
      } else {
        if (result.ok) {
          failures.add(
            '${c['id']}: expected error ${expect['code']}, got ok ${result.value}',
          );
          continue;
        }
        if (result.code != expect['code']) {
          failures.add(
            '${c['id']}: expected ${expect['code']}, got ${result.code}',
          );
        }
      }
    }
    expect(failures, isEmpty, reason: failures.join('\n'));
  });
}
