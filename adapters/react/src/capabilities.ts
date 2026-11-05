import type { CapabilityDetail, RendererCapabilityManifest } from '@vds-form/types';
import {
  allLayoutsSupported, capHostAdapter, capSupported, capUnsupported, featuresFromStatus,
} from '@vds-form/types';
import { defaultFieldRegistry } from '@vds-form/fields';

const SUPPORTED = [
  'text', 'textarea', 'email', 'password', 'url', 'phone',
  'integer', 'decimal', 'currency', 'percentage', 'range',
  'select', 'multiselect', 'radio', 'checkbox', 'switch', 'consent',
  'date', 'time', 'datetime', 'duration', 'rating', 'color', 'barcode',
  'file', 'image', 'computed', 'hidden', 'group', 'repeater',
];

const FEATURE_STATUS: Record<string, CapabilityDetail> = {
  multiStep: capSupported(),
  repeaters: capSupported(),
  localization: capSupported(),
  accessibility: capSupported(),
  uploadProgress: capSupported(),
  uploadCancel: capSupported(),
  dragDrop: capSupported(),
  filePicker: capSupported(),
  camera: capUnsupported('Browsers expose no general camera capture API through this renderer.'),
  draftPersistence: capHostAdapter(['DraftStorageAdapter'], 'Implemented in the shared runtime; durable storage must be injected.'),
  offlineQueue: capHostAdapter(['OfflineQueueAdapter'], 'Implemented in the shared runtime; a queue adapter must be injected.'),
  richText: capUnsupported('No rich-text editor is implemented.'),
  signature: capUnsupported('No signature pad is implemented.'),
};

const FIELD_STATUS: Record<string, CapabilityDetail> = {
  signature: capUnsupported('No signature pad is implemented.'),
  barcode: capHostAdapter(['BarcodeDetector or a host scanner'], 'Manual entry works; scanning needs a host detector.'),
};

export const REACT_CAPABILITY_MANIFEST: RendererCapabilityManifest = {
  target: 'react',
  contractVersion: '1.0.0',
  fieldTypes: Object.fromEntries(
    SUPPORTED.map((t) => [t, { ...defaultFieldRegistry.get(t)!.capability }]),
  ),
  features: featuresFromStatus(FEATURE_STATUS),
  featureStatus: FEATURE_STATUS,
  fieldStatus: FIELD_STATUS,
  layoutStatus: allLayoutsSupported(),
  evidence: {
    unit: 'npm run test:web / test:angular (vitest)',
    ci: '.github/workflows/ci.yml job: typescript',
  },
};
