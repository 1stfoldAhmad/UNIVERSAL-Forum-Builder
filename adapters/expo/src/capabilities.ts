import type { RendererCapabilityManifest } from '@vds-form/types';
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
  return {
    target: 'expo',
    contractVersion: '1.0.0',
    fieldTypes,
    features: {
      filePicker: Boolean(pickers.pickDocument || pickers.pickImage),
      camera: Boolean(pickers.captureCamera),
      dragDrop: false,
      offlineQueue: true,
      draftPersistence: true,
      multiStep: true,
      repeaters: true,
      richText: false,
      signature: false,
    },
  };
}

export const EXPO_BASE_MANIFEST = createExpoCapabilityManifest();
