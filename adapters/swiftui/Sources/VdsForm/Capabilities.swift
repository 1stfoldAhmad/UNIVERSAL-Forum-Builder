import Foundation

/// Renderer capability manifest for the SwiftUI target (shared contract).
///
/// HONESTY RULE: `supported` only when implemented, wired, tested AND usable.
/// Anything needing a host adapter is `requires-host-adapter`, never `supported`.
/// The JSON mirror specifications/capabilities/swiftui.json is asserted equal to
/// this map by CapabilitiesTests, so docs cannot drift from code.
public enum Capabilities {
    public static let supported: [String] = [
        "text", "textarea", "email", "password", "url", "phone", "integer", "decimal",
        "currency", "percentage", "duration", "date", "time", "datetime", "select",
        "multiselect", "radio", "checkbox", "switch", "consent", "rating", "range",
        "color", "file", "image", "computed", "hidden", "group", "repeater", "barcode",
    ]

    public static let layoutNodes: [String] = [
        "section", "group", "row", "columns", "tabs", "tab", "accordion", "steps",
        "step", "fieldset", "summary", "repeater", "divider", "text",
    ]

    private static func sup() -> [String: Any] { ["status": "supported"] }
    private static func unsupported(_ reason: String) -> [String: Any] { ["status": "unsupported", "reason": reason] }
    private static func host(_ reason: String, _ requires: [String]) -> [String: Any] {
        ["status": "requires-host-adapter", "requires": requires, "reason": reason]
    }

    public static func manifest() -> [String: Any] {
        var fieldTypes: [String: Any] = [:]
        for t in supported { fieldTypes[t] = ["fieldType": t, "supported": true] }
        var layoutStatus: [String: Any] = [:]
        for n in layoutNodes { layoutStatus[n] = sup() }

        return [
            "target": "swiftui",
            "contractVersion": "1.0.0",
            "fieldTypes": fieldTypes,
            "features": [
                "dragDrop": false, "filePicker": false, "camera": false, "offlineQueue": false,
                "draftPersistence": false, "multiStep": true, "repeaters": true,
                "richText": false, "signature": false,
            ] as [String: Any],
            "featureStatus": [
                "multiStep": sup(), "repeaters": sup(),
                "localization": sup(), "accessibility": sup(),
                "submissionGuard": sup(), "uploadProgress": sup(), "uploadCancel": sup(),
                "filePicker": host("Renderer wires selection, progress, cancel and asset refs; no picker dependency is bundled.", ["FilePickerAdapter", "UploadAdapter"]),
                "camera": host("Capture is delegated to a host camera adapter.", ["CameraAdapter", "UploadAdapter"]),
                "barcode": host("Scanning is delegated to a host scanner adapter.", ["BarcodeAdapter"]),
                "draftPersistence": host("save/restore/clear implemented; durable storage is host-supplied.", ["DraftAdapter"]),
                "offlineQueue": unsupported("No offline submission queue is implemented on this target."),
                "dragDrop": unsupported("No drag-and-drop source is implemented on this target."),
                "richText": unsupported("No rich-text editor is implemented."),
                "signature": unsupported("No signature pad is implemented; the control states this explicitly."),
            ] as [String: Any],
            "fieldStatus": [
                "file": ["status": "requires-host-adapter", "requires": ["FilePickerAdapter", "UploadAdapter"]],
                "image": ["status": "requires-host-adapter", "requires": ["FilePickerAdapter", "UploadAdapter"]],
                "barcode": ["status": "requires-host-adapter", "requires": ["BarcodeAdapter"]],
                "signature": unsupported("No signature pad is implemented."),
                "color": ["status": "supported", "reason": "Fixed accessible palette plus hex readout."],
                "date": sup(), "time": sup(), "datetime": sup(),
                "multiselect": sup(), "radio": sup(),
            ] as [String: Any],
            "layoutStatus": layoutStatus,
            "evidence": [
                "unit": "swift test (adapters/swiftui)",
                "ci": ".github/workflows/ci.yml job: swiftui",
                "device": "pending — no physical-device verification performed",
            ] as [String: Any],
        ]
    }
}
