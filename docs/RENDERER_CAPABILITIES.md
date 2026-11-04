# Renderer capability honesty

Capabilities are advertised only when backed by implementation + tests. `trust: 'sandboxed'` is **not** isolation; no sandbox exists.

| Feature | React | Vue | Angular | Expo |
|---|---|---|---|---|
| dragDrop | true | true | true | **false** (no native drag-drop claim) |
| filePicker | true | true (button → hidden input tested) | true | only when host injects `pickImage`/`pickDocument` |
| camera | false | false | false | only when host injects `captureCamera` (tested via injected adapter) |
| offlineQueue / draftPersistence | true | true | true | true (host storage adapter required for durability) |
| multiStep / repeaters | true | true | true | true |
| richText / signature | false | false | false | false |

## Expo uploads
- Multiple documents: all selected assets processed when `validation.multiple` is true.
- Existing uploaded assets are preserved when adding more.
- Partial failures keep successful uploads and surface a structured error message.
- Camera is implemented as a host-injected adapter; without it the capability is false and the UI shows unsupported state.
- Verification is RN-web/jsdom with injected adapters; **on-device verification is not claimed**.

## Custom plugin field renderers
`RendererComponentRegistry` (plugin SDK) registers opaque platform components keyed by `${target}:${fieldType}`. Registration does not automatically advertise capabilities; compiler negotiation still uses the renderer capability manifest. Plugin trust remains fail-closed: `sandboxed`/`untrusted` manifests are rejected until a real isolation adapter exists.
