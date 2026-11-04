import type { RendererCapabilityManifest } from '@vds-form/types';
import { defaultFieldRegistry } from '@vds-form/fields';

const SUPPORTED = [
  'text', 'textarea', 'email', 'password', 'url', 'phone',
  'integer', 'decimal', 'currency', 'percentage', 'range',
  'select', 'multiselect', 'radio', 'checkbox', 'switch', 'consent',
  'date', 'time', 'datetime', 'duration', 'rating', 'color', 'barcode',
  'file', 'image', 'computed', 'hidden', 'group', 'repeater',
];

export const REACT_CAPABILITY_MANIFEST: RendererCapabilityManifest = {
  target: 'react',
  contractVersion: '1.0.0',
  fieldTypes: Object.fromEntries(
    SUPPORTED.map((t) => [t, { ...defaultFieldRegistry.get(t)!.capability }]),
  ),
  features: {
    dragDrop: true,
    filePicker: true,
    camera: false,
    offlineQueue: true,
    draftPersistence: true,
    multiStep: true,
    repeaters: true,
    richText: false,
    signature: false,
  },
};
