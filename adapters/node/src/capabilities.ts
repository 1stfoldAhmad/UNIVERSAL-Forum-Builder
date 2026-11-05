import type { CapabilityDetail, RendererCapabilityManifest } from '@vds-form/types';
import { defaultFieldRegistry } from '@vds-form/fields';
import {
  CANONICAL_LAYOUT_NODES, capHostAdapter, capPartial, capSupported, capUnsupported, featuresFromStatus,
} from '@vds-form/types';

const SUPPORTED = defaultFieldRegistry.list().map((c) => c.type).filter((t) => t !== 'signature');

/**
 * Capability manifest for the Node target.
 *
 * Node is a TRUSTED BACKEND EXECUTION ADAPTER, not a UI renderer. The HTML
 * surface described here is the explicitly separate server-rendered/hydrated
 * form feature (adapters/node/src/html.ts + client.ts).
 *
 * Interactive layout containers (tabs/accordion) and grid rows are rendered as
 * plain containers by the static HTML renderer, so they are reported `partial`
 * rather than claimed as full parity with the SPA renderers.
 */
const FEATURE_STATUS: Record<string, CapabilityDetail> = {
  multiStep: capSupported(),
  repeaters: capSupported(),
  localization: capSupported(),
  accessibility: capSupported(),
  filePicker: capSupported(),
  uploadProgress: capSupported(),
  uploadCancel: capSupported(),
  dragDrop: capUnsupported('The hydration client registers no drag-and-drop handlers.'),
  camera: capUnsupported('No camera capture is implemented.'),
  draftPersistence: capHostAdapter(['DraftStorageAdapter'], 'Implemented in the shared runtime; durable storage must be injected.'),
  offlineQueue: capHostAdapter(['OfflineQueueAdapter'], 'Implemented in the shared runtime; a queue adapter must be injected.'),
  richText: capUnsupported('No rich-text editor is implemented.'),
  signature: capUnsupported('No signature pad is implemented.'),
};

const FIELD_STATUS: Record<string, CapabilityDetail> = {
  signature: capUnsupported('No signature pad is implemented.'),
  file: capHostAdapter(['UploadProvider'], 'Renders a file input; transfer requires an injected upload provider.'),
  image: capHostAdapter(['UploadProvider'], 'Renders a file input; transfer requires an injected upload provider.'),
  barcode: capPartial('Text entry only; no scanner is available server-side.'),
};

const INTERACTIVE_CONTAINERS = new Set(['tabs', 'accordion', 'row', 'columns', 'fieldset']);

export const NODE_CAPABILITY_MANIFEST: RendererCapabilityManifest = {
  target: 'node',
  contractVersion: '1.0.0',
  fieldTypes: Object.fromEntries(SUPPORTED.map((t) => {
    const cap = { ...defaultFieldRegistry.get(t)!.capability };
    if (t === 'file' || t === 'image') cap.fallbackStrategy = 'upload-provider-required';
    return [t, cap];
  })),
  features: featuresFromStatus(FEATURE_STATUS),
  featureStatus: FEATURE_STATUS,
  fieldStatus: FIELD_STATUS,
  layoutStatus: Object.fromEntries(CANONICAL_LAYOUT_NODES.map((n) => [
    n,
    INTERACTIVE_CONTAINERS.has(n)
      ? capPartial('Server-rendered as a plain container; no interactive tab/accordion/grid behaviour.')
      : capSupported(),
  ])),
  evidence: {
    unit: 'npm test (vitest) — adapters/node',
    ci: '.github/workflows/ci.yml job: typescript',
  },
};
