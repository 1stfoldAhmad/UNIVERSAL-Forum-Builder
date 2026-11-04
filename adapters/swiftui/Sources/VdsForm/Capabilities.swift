import Foundation

/// Renderer capability manifest for the SwiftUI target (shared contract).
public enum Capabilities {
    public static let supported: [String] = [
        "text", "textarea", "email", "password", "url", "phone", "integer", "decimal",
        "currency", "percentage", "duration", "date", "time", "datetime", "select",
        "multiselect", "radio", "checkbox", "switch", "consent", "rating", "range",
        "color", "file", "image", "computed", "hidden", "group", "repeater", "barcode",
    ]

    public static func manifest() -> [String: Any] {
        var fieldTypes: [String: Any] = [:]
        for t in supported { fieldTypes[t] = ["fieldType": t, "supported": true] }
        return [
            "target": "swiftui",
            "contractVersion": "1.0.0",
            "fieldTypes": fieldTypes,
            "features": [
                "dragDrop": false, "filePicker": true, "camera": true, "offlineQueue": true,
                "draftPersistence": true, "multiStep": true, "repeaters": true, "richText": false, "signature": false,
            ] as [String: Any],
        ]
    }
}
