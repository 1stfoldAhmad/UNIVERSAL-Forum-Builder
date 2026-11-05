# Platform support matrix

> **Generated file — do not edit by hand.**
> Regenerate with `npm run support-matrix`; CI fails if it is out of date (`npm run support-matrix:check`).

Every cell below is derived from a renderer capability manifest in
`specifications/capabilities/*.json`. Those manifests are verified against the
renderers themselves: TypeScript mirrors are generated from the exported
manifests, and the Dart/Kotlin/Swift manifests are asserted equal to their
mirrors by each platform’s own test suite. **No equivalence is claimed by hand.**

## Legend

| Symbol | Status | Meaning |
| --- | --- | --- |
| ✅ | Supported | Implemented, wired, tested and usable as-is. |
| 🟡 | Partial | Works with the documented limitation in the manifest. |
| 🔌 | Requires host adapter | Renderer code exists; a host-injected adapter is required before use. |
| — | Unsupported | Not implemented on this target. |

A capability is never marked ✅ merely because an interface exists or the code compiles.

## Field types

| Field | `react` | `vue` | `angular` | `expo` | `node` | `flutter` | `compose` | `swiftui` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `barcode` | 🔌 | 🔌 | 🔌 | 🔌 | 🟡 | 🔌 | 🔌 | 🔌 |
| `checkbox` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `color` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `computed` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `consent` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `currency` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `date` | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ |
| `datetime` | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ |
| `decimal` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `duration` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `email` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file` | ✅ | ✅ | ✅ | 🔌 | 🔌 | 🔌 | 🔌 | 🔌 |
| `group` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `hidden` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `image` | ✅ | ✅ | ✅ | 🔌 | 🔌 | 🔌 | 🔌 | 🔌 |
| `integer` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `multiselect` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `password` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `percentage` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `phone` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `radio` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `range` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `rating` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `repeater` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `select` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `signature` | — | — | — | — | — | — | — | — |
| `switch` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `text` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `textarea` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `time` | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ |
| `url` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Layout nodes (all 14 canonical types)

| Layout node | `react` | `vue` | `angular` | `expo` | `node` | `flutter` | `compose` | `swiftui` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `section` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `group` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `row` | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| `columns` | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| `tabs` | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| `tab` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `accordion` | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| `steps` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `step` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fieldset` | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| `summary` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `repeater` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `divider` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `text` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Features

| Feature | `react` | `vue` | `angular` | `expo` | `node` | `flutter` | `compose` | `swiftui` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Multi-step wizards | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Repeaters | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Localization | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Accessibility semantics | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| File / image selection | ✅ | ✅ | ✅ | 🔌 | ✅ | 🔌 | 🔌 | 🔌 |
| Camera capture | — | — | — | 🔌 | — | 🔌 | 🔌 | 🔌 |
| Barcode scanning | — | — | — | — | — | 🔌 | 🔌 | 🔌 |
| Signature capture | — | — | — | — | — | — | — | — |
| Rich text | — | — | — | — | — | — | — | — |
| Drag & drop upload | ✅ | ✅ | ✅ | — | — | — | — | — |
| Draft persistence | 🔌 | 🔌 | 🔌 | 🔌 | 🔌 | 🔌 | 🔌 | 🔌 |
| Offline queue | 🔌 | 🔌 | 🔌 | 🔌 | 🔌 | — | — | — |
| Upload progress | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Upload cancellation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Single active submission | — | — | — | — | — | ✅ | ✅ | ✅ |

## Required host adapters

These are the injection points a host application must supply. Nothing here is
bundled, and none of it is a production VDS service — supply your own.

### `react`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| draftPersistence | `DraftStorageAdapter` | Implemented in the shared runtime; durable storage must be injected. |
| offlineQueue | `OfflineQueueAdapter` | Implemented in the shared runtime; a queue adapter must be injected. |

### `vue`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| draftPersistence | `DraftStorageAdapter` | Implemented in the shared runtime; durable storage must be injected. |
| offlineQueue | `OfflineQueueAdapter` | Implemented in the shared runtime; a queue adapter must be injected. |

### `angular`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| draftPersistence | `DraftStorageAdapter` | Implemented in the shared runtime; durable storage must be injected. |
| offlineQueue | `OfflineQueueAdapter` | Implemented in the shared runtime; a queue adapter must be injected. |

### `expo`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| filePicker | `ExpoPickerAdapters.pickDocument`, `ExpoPickerAdapters.pickImage` | No picker injected: file controls are disabled. |
| camera | `ExpoPickerAdapters.captureCamera` | No camera adapter injected. |
| draftPersistence | `DraftStorageAdapter` | Implemented in the shared runtime; durable storage must be injected. |
| offlineQueue | `OfflineQueueAdapter` | Implemented in the shared runtime; a queue adapter must be injected. |

### `node`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| draftPersistence | `DraftStorageAdapter` | Implemented in the shared runtime; durable storage must be injected. |
| offlineQueue | `OfflineQueueAdapter` | Implemented in the shared runtime; a queue adapter must be injected. |

### `flutter`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| filePicker | `FilePickerAdapter`, `UploadAdapter` | Flutter renderer wires selection, progress, cancel and asset refs, but ships no picker plugin. |
| camera | `CameraAdapter`, `UploadAdapter` | Capture is delegated to a host camera adapter; no camera plugin is bundled. |
| barcode | `BarcodeAdapter` | Scanning is delegated to a host scanner adapter. |
| draftPersistence | `DraftAdapter` | save/restore/clear are implemented; durable storage is host-supplied. |

### `compose`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| filePicker | `FilePickerAdapter`, `UploadAdapter` | Renderer wires selection, progress, cancel and asset refs; no picker dependency is bundled. |
| camera | `CameraAdapter`, `UploadAdapter` | Capture is delegated to a host camera adapter. |
| barcode | `BarcodeAdapter` | Scanning is delegated to a host scanner adapter. |
| draftPersistence | `DraftAdapter` | save/restore/clear implemented; durable storage is host-supplied. |

### `swiftui`

| Capability | Required adapter(s) | Note |
| --- | --- | --- |
| filePicker | `FilePickerAdapter`, `UploadAdapter` | Renderer wires selection, progress, cancel and asset refs; no picker dependency is bundled. |
| camera | `CameraAdapter`, `UploadAdapter` | Capture is delegated to a host camera adapter. |
| barcode | `BarcodeAdapter` | Scanning is delegated to a host scanner adapter. |
| draftPersistence | `DraftAdapter` | save/restore/clear implemented; durable storage is host-supplied. |

## Documented limitations (partial / unsupported)

| Target | Capability | Status | Reason |
| --- | --- | --- | --- |
| `react` | camera | unsupported | Browsers expose no general camera capture API through this renderer. |
| `react` | richText | unsupported | No rich-text editor is implemented. |
| `react` | signature | unsupported | No signature pad is implemented. |
| `react` | field `signature` | unsupported | No signature pad is implemented. |
| `vue` | camera | unsupported | Browsers expose no general camera capture API through this renderer. |
| `vue` | richText | unsupported | No rich-text editor is implemented. |
| `vue` | signature | unsupported | No signature pad is implemented. |
| `vue` | field `signature` | unsupported | No signature pad is implemented. |
| `angular` | camera | unsupported | Browsers expose no general camera capture API through this renderer. |
| `angular` | richText | unsupported | No rich-text editor is implemented. |
| `angular` | signature | unsupported | No signature pad is implemented. |
| `angular` | field `signature` | unsupported | No signature pad is implemented. |
| `expo` | dragDrop | unsupported | React Native has no drag-and-drop source. |
| `expo` | richText | unsupported | No rich-text editor is implemented. |
| `expo` | signature | unsupported | No signature pad is implemented. |
| `expo` | field `signature` | unsupported | No signature pad is implemented. |
| `expo` | field `date` | partial | ISO text input; no native date picker is bundled. |
| `expo` | field `time` | partial | ISO text input; no native time picker is bundled. |
| `expo` | field `datetime` | partial | ISO text input; no native datetime picker is bundled. |
| `node` | dragDrop | unsupported | The hydration client registers no drag-and-drop handlers. |
| `node` | camera | unsupported | No camera capture is implemented. |
| `node` | richText | unsupported | No rich-text editor is implemented. |
| `node` | signature | unsupported | No signature pad is implemented. |
| `node` | field `signature` | unsupported | No signature pad is implemented. |
| `node` | field `barcode` | partial | Text entry only; no scanner is available server-side. |
| `node` | layout `row` | partial | Server-rendered as a plain container; no interactive tab/accordion/grid behaviour. |
| `node` | layout `columns` | partial | Server-rendered as a plain container; no interactive tab/accordion/grid behaviour. |
| `node` | layout `tabs` | partial | Server-rendered as a plain container; no interactive tab/accordion/grid behaviour. |
| `node` | layout `accordion` | partial | Server-rendered as a plain container; no interactive tab/accordion/grid behaviour. |
| `node` | layout `fieldset` | partial | Server-rendered as a plain container; no interactive tab/accordion/grid behaviour. |
| `flutter` | offlineQueue | unsupported | No offline submission queue is implemented on this target. |
| `flutter` | dragDrop | unsupported | No drag-and-drop source on mobile Flutter. |
| `flutter` | richText | unsupported | No rich-text editor is implemented. |
| `flutter` | signature | unsupported | No signature pad is implemented; the control states this explicitly. |
| `flutter` | field `signature` | unsupported | No signature pad is implemented. |
| `compose` | offlineQueue | unsupported | No offline submission queue is implemented on this target. |
| `compose` | dragDrop | unsupported | No drag-and-drop source on Android Compose. |
| `compose` | richText | unsupported | No rich-text editor is implemented. |
| `compose` | signature | unsupported | No signature pad is implemented; the control states this explicitly. |
| `compose` | field `signature` | unsupported | No signature pad is implemented. |
| `swiftui` | offlineQueue | unsupported | No offline submission queue is implemented on this target. |
| `swiftui` | dragDrop | unsupported | No drag-and-drop source is implemented on this target. |
| `swiftui` | richText | unsupported | No rich-text editor is implemented. |
| `swiftui` | signature | unsupported | No signature pad is implemented; the control states this explicitly. |
| `swiftui` | field `signature` | unsupported | No signature pad is implemented. |

## CI verification

Version combinations below are read from `.github/workflows/ci.yml`. A row
describes what CI is **configured to run**; the pass/fail result of a specific
run is recorded in `docs/audit/FINAL_COMPLETION_AUDIT_2026.md` with its run id.

| Job | Runner | Matrix |
| --- | --- | --- |
| `typescript` | ubuntu-latest | node: 22, 24, 26 |
| `nextjs` | ubuntu-latest | single configuration |
| `django` | ubuntu-latest | Django 5.2.19 × Python 3.10, 3.11, 3.12, 3.13, 3.14; Django 6.1.3 × Python 3.12, 3.13, 3.14, 3.15 |
| `laravel` | ubuntu-latest | php: 8.3, 8.4, 8.5 |
| `laravel13` | ubuntu-latest | php: 8.3, 8.4, 8.5 |
| `flutter` | ubuntu-latest | single configuration |
| `compose` | ubuntu-latest | single configuration |
| `swiftui` | macos-latest | single configuration |
| `packaging` | ubuntu-latest | package: execution-adapters/django, adapters/django |

## Packaging evidence

| Target | Artifact | CI step | Published? |
| --- | --- | --- | --- |
| TypeScript packages | JS + `.d.ts`, npm tarballs | `typescript` → build/pack/fresh-install smoke | **No** |
| Python (execution + renderer) | wheel + sdist | `packaging` → build + fresh-venv install | **No** |
| PHP / Laravel | Composer package | `laravel`, `laravel13` → `composer validate` + fresh consumer install | **No** |
| Flutter | pub package | `flutter` → `pub publish --dry-run` | **No** |
| Compose | `core.jar` + UI AAR | `compose` → `:core:jar :ui:assembleRelease` | **No** |
| SwiftUI | SwiftPM targets | `swiftui` → `swift build` + `package describe` | **No** |

Local builds are packaging evidence, **not** a production-readiness claim.

## Physical-device verification

**Status: pending.** No physical iOS or Android device verification has been
performed. Camera capture, native pickers, permission prompts, real-lifecycle
uploads, restart durability and offline transitions remain to be verified on
device by the host application. Automated tests use injected fake adapters and
never claim device behaviour.
