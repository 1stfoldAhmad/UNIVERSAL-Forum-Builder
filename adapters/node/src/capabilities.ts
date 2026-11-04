import type { RendererCapabilityManifest } from '@vds-form/types';
import { defaultFieldRegistry } from '@vds-form/fields';

const SUPPORTED = defaultFieldRegistry.list().map((c) => c.type).filter((t) => t !== 'signature');

export const NODE_CAPABILITY_MANIFEST: RendererCapabilityManifest = {
  target: 'node',
  contractVersion: '1.0.0',
  fieldTypes: Object.fromEntries(SUPPORTED.map((t) => {
    const cap = { ...defaultFieldRegistry.get(t)!.capability };
    if (t === 'file' || t === 'image') cap.fallbackStrategy = 'upload-provider-required';
    return [t, cap];
  })),
  features: {
    dragDrop: true, filePicker: true, camera: false, offlineQueue: true,
    draftPersistence: true, multiStep: true, repeaters: true, richText: false, signature: false,
  },
};
