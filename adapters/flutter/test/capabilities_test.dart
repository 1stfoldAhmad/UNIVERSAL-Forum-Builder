/// The checked-in JSON mirror must equal the language-native manifest, so the
/// generated support matrix can never drift from what the renderer declares.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vds_form_flutter/vds_form_flutter.dart';

String capabilitiesDir() =>
    Platform.environment['VDS_CAPABILITIES'] ?? '../../specifications/capabilities';

void main() {
  test('flutter manifest matches specifications/capabilities/flutter.json', () {
    final mirror = jsonDecode(File('${capabilitiesDir()}/flutter.json').readAsStringSync());
    expect(flutterCapabilityManifest, equals(mirror));
  });

  test('every canonical layout node is declared', () {
    final declared = (flutterCapabilityManifest['layoutStatus'] as Map).keys.toSet();
    expect(declared, equals(canonicalLayoutNodes.toSet()));
    expect(canonicalLayoutNodes.length, 14);
  });

  test('no capability is claimed supported without being usable out of the box', () {
    final features = flutterCapabilityManifest['features'] as Map;
    final statuses = flutterCapabilityManifest['featureStatus'] as Map;
    for (final entry in features.entries) {
      final detail = statuses[entry.key] as Map?;
      expect(detail, isNotNull, reason: 'feature ${entry.key} has no explicit status');
      // The boolean shorthand may only be true when the status is `supported`.
      expect(entry.value, (detail!['status'] == 'supported'),
          reason: 'feature ${entry.key} boolean disagrees with its status');
    }
  });

  test('host-dependent capabilities are never advertised as supported', () {
    final statuses = flutterCapabilityManifest['featureStatus'] as Map;
    for (final key in ['filePicker', 'camera', 'barcode', 'draftPersistence']) {
      expect((statuses[key] as Map)['status'], 'requires-host-adapter');
      expect((statuses[key] as Map)['requires'], isNotEmpty);
    }
    expect((statuses['offlineQueue'] as Map)['status'], 'unsupported');
    expect((statuses['signature'] as Map)['status'], 'unsupported');
    expect(supportedFieldTypes.contains('signature'), isFalse);
  });
}
