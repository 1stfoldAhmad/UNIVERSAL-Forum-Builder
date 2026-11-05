/// Renderer capability manifest for the Flutter target (shared contract).
///
/// HONESTY RULE: a capability is `supported` only when it is implemented, wired
/// into the widget tree, covered by tests AND usable. Anything needing a host
/// plugin is `requires-host-adapter`, never `supported`.
///
/// The JSON mirror at specifications/capabilities/flutter.json is asserted equal
/// to this map by test/capabilities_test.dart, so docs cannot drift from code.
library;

/// Field types this renderer can actually render (excludes unsupported ones).
const List<String> supportedFieldTypes = [
  'text', 'textarea', 'email', 'password', 'url', 'phone', 'integer', 'decimal',
  'currency', 'percentage', 'duration', 'date', 'time', 'datetime', 'select',
  'multiselect', 'radio', 'checkbox', 'switch', 'consent', 'rating', 'range',
  'color', 'file', 'image', 'computed', 'hidden', 'group', 'repeater', 'barcode',
];

const List<String> canonicalLayoutNodes = [
  'section', 'group', 'row', 'columns', 'tabs', 'tab', 'accordion', 'steps',
  'step', 'fieldset', 'summary', 'repeater', 'divider', 'text',
];

/// Field capability map, structurally identical to the Compose/SwiftUI manifests.
Map<String, dynamic> get flutterFieldTypes => {
      for (final t in supportedFieldTypes) t: {'fieldType': t, 'supported': true},
    };

final Map<String, dynamic> flutterCapabilityManifest = {
  'target': 'flutter',
  'contractVersion': '1.0.0',
  'fieldTypes': flutterFieldTypes,
  'features': {
    'dragDrop': false,
    'filePicker': false,
    'camera': false,
    'offlineQueue': false,
    'draftPersistence': false,
    'multiStep': true,
    'repeaters': true,
    'richText': false,
    'signature': false,
  },
  'featureStatus': {
    'multiStep': {'status': 'supported'},
    'repeaters': {'status': 'supported'},
    'localization': {'status': 'supported'},
    'accessibility': {'status': 'supported'},
    'submissionGuard': {'status': 'supported'},
    'uploadProgress': {'status': 'supported'},
    'uploadCancel': {'status': 'supported'},
    'filePicker': {
      'status': 'requires-host-adapter',
      'requires': ['FilePickerAdapter', 'UploadAdapter'],
      'reason': 'Flutter renderer wires selection, progress, cancel and asset refs, but ships no picker plugin.',
    },
    'camera': {
      'status': 'requires-host-adapter',
      'requires': ['CameraAdapter', 'UploadAdapter'],
      'reason': 'Capture is delegated to a host camera adapter; no camera plugin is bundled.',
    },
    'barcode': {
      'status': 'requires-host-adapter',
      'requires': ['BarcodeAdapter'],
      'reason': 'Scanning is delegated to a host scanner adapter.',
    },
    'draftPersistence': {
      'status': 'requires-host-adapter',
      'requires': ['DraftAdapter'],
      'reason': 'save/restore/clear are implemented; durable storage is host-supplied.',
    },
    'offlineQueue': {'status': 'unsupported', 'reason': 'No offline submission queue is implemented on this target.'},
    'dragDrop': {'status': 'unsupported', 'reason': 'No drag-and-drop source on mobile Flutter.'},
    'richText': {'status': 'unsupported', 'reason': 'No rich-text editor is implemented.'},
    'signature': {'status': 'unsupported', 'reason': 'No signature pad is implemented; the control states this explicitly.'},
  },
  'fieldStatus': {
    'file': {'status': 'requires-host-adapter', 'requires': ['FilePickerAdapter', 'UploadAdapter']},
    'image': {'status': 'requires-host-adapter', 'requires': ['FilePickerAdapter', 'UploadAdapter']},
    'barcode': {'status': 'requires-host-adapter', 'requires': ['BarcodeAdapter']},
    'signature': {'status': 'unsupported', 'reason': 'No signature pad is implemented.'},
    'color': {'status': 'supported', 'reason': 'Fixed accessible palette plus hex readout.'},
    'date': {'status': 'supported'},
    'time': {'status': 'supported'},
    'datetime': {'status': 'supported'},
  },
  'layoutStatus': {
    'section': {'status': 'supported'}, 'group': {'status': 'supported'},
    'row': {'status': 'supported'}, 'columns': {'status': 'supported'},
    'tabs': {'status': 'supported'}, 'tab': {'status': 'supported'},
    'accordion': {'status': 'supported'}, 'steps': {'status': 'supported'},
    'step': {'status': 'supported'}, 'fieldset': {'status': 'supported'},
    'summary': {'status': 'supported'}, 'repeater': {'status': 'supported'},
    'divider': {'status': 'supported'}, 'text': {'status': 'supported'},
  },
  'evidence': {
    'unit': 'flutter test (adapters/flutter)',
    'ci': '.github/workflows/ci.yml job: flutter',
    'device': 'pending — no physical-device verification performed',
  },
};
