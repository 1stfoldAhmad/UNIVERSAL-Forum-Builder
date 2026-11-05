import type { CapabilityDetail, RendererCapabilityManifest } from '@vds-form/types';
import {
  allLayoutsSupported, capHostAdapter, capPartial, capSupported, capUnsupported, featuresFromStatus,
} from '@vds-form/types';
import { defaultFieldRegistry } from '@vds-form/fields';

/** Native picker adapters injected by the host app (expo-image-picker / expo-document-picker). */
export interface ExpoPickerAdapters {
  pickImage?: (opts: { accept?: string[] }) => Promise<import('@vds-form/types').NormalizedAsset | null>;
  pickDocument?: (opts: { accept?: string[]; multiple?: boolean }) => Promise<import('@vds-form/types').NormalizedAsset[] | null>;
  captureCamera?: () => Promise<import('@vds-form/types').NormalizedAsset | null>;
}

const SUPPORTED = [
  'text', 'textarea', 'email', 'password', 'url', 'phone',
  'integer', 'decimal', 'currency', 'percentage', 'range',
  'select', 'multiselect', 'radio', 'checkbox', 'switch', 'consent',
  'date', 'time', 'datetime', 'duration', 'rating', 'color', 'barcode',
  'file', 'image', 'computed', 'hidden', 'group', 'repeater',
];

/**
 * Capability manifest for the Expo renderer. File/camera features are only
 * advertised when the host actually injects the corresponding native picker —
 * no silent capability inflation.
 */
export function createExpoCapabilityManifest(pickers: ExpoPickerAdapters = {}): RendererCapabilityManifest {
  const fieldTypes: RendererCapabilityManifest['fieldTypes'] = {};
  for (const type of SUPPORTED) {
    const contract = defaultFieldRegistry.get(type);
    if (!contract) continue;
    fieldTypes[type] = { ...contract.capability };
    if ((type === 'date' || type === 'time' || type === 'datetime')) {
      fieldTypes[type] = { ...fieldTypes[type], fallbackStrategy: 'iso-text-input' };
    }
    if (type === 'range') fieldTypes[type] = { ...fieldTypes[type], fallbackStrategy: 'numeric-stepper' };
  }
  const featureStatus: Record<string, CapabilityDetail> = {
    multiStep: capSupported(),
    repeaters: capSupported(),
    localization: capSupported(),
    accessibility: capSupported(),
    uploadProgress: capSupported(),
    uploadCancel: capSupported(),
    filePicker: pickers.pickDocument || pickers.pickImage
      ? capSupported()
      : capHostAdapter(['ExpoPickerAdapters.pickDocument', 'ExpoPickerAdapters.pickImage'], 'No picker injected: file controls are disabled.'),
    camera: pickers.captureCamera
      ? capSupported()
      : capHostAdapter(['ExpoPickerAdapters.captureCamera'], 'No camera adapter injected.'),
    draftPersistence: capHostAdapter(['DraftStorageAdapter'], 'Implemented in the shared runtime; durable storage must be injected.'),
    offlineQueue: capHostAdapter(['OfflineQueueAdapter'], 'Implemented in the shared runtime; a queue adapter must be injected.'),
    dragDrop: capUnsupported('React Native has no drag-and-drop source.'),
    richText: capUnsupported('No rich-text editor is implemented.'),
    signature: capUnsupported('No signature pad is implemented.'),
  };

  const fieldStatus: Record<string, CapabilityDetail> = {
    signature: capUnsupported('No signature pad is implemented.'),
    date: capPartial('ISO text input; no native date picker is bundled.'),
    time: capPartial('ISO text input; no native time picker is bundled.'),
    datetime: capPartial('ISO text input; no native datetime picker is bundled.'),
    barcode: capHostAdapter(['host scanner'], 'Manual entry works; scanning needs a host adapter.'),
    file: featureStatus.filePicker,
    image: featureStatus.filePicker,
  };

  return {
    target: 'expo',
    contractVersion: '1.0.0',
    fieldTypes,
    features: featuresFromStatus(featureStatus),
    featureStatus,
    fieldStatus,
    layoutStatus: allLayoutsSupported(),
    evidence: {
      unit: 'npm run test:native (vitest)',
      ci: '.github/workflows/ci.yml job: typescript',
      device: 'pending — no physical-device verification performed',
    },
  };
}

export const EXPO_BASE_MANIFEST = createExpoCapabilityManifest();
