import Foundation

/// Conservative capability manifest; partial entries are not full conformance claims.
public enum Capabilities {
    private static let fieldTypes = [
        "text", "textarea", "email", "password", "url", "phone", "integer", "decimal",
        "currency", "percentage", "duration", "date", "time", "datetime", "select",
        "multiselect", "radio", "checkbox", "switch", "consent", "rating", "range",
        "color", "file", "image", "computed", "hidden", "group", "repeater", "barcode", "signature",
    ]

    private static func status(_ value: String) -> [String: String] { ["status": value] }

    public static func manifest() -> [String: Any] {
        var fields: [String: Any] = [:]
        for field in fieldTypes {
            let value = field == "hidden" ? "supported"
                : (["file", "image", "signature"].contains(field) ? "unsupported" : "partial")
            fields[field] = status(value)
        }
        return [
            "target": "swiftui",
            "contractVersion": "1.0.0",
            "fieldTypes": fields,
            "features": [
                "dragDrop": status("unsupported"),
                "filePicker": status("unsupported"),
                "camera": status("unsupported"),
                "upload": status("requires-host-adapter"),
                "offlineQueue": status("unsupported"),
                "draftPersistence": status("unsupported"),
                "multiStep": status("partial"),
                "repeaters": status("partial"),
                "dynamicOptions": status("partial"),
                "layout": status("partial"),
                "localization": status("partial"),
                "accessibility": status("partial"),
                "signature": status("unsupported"),
                "barcode": status("partial"),
            ] as [String: Any],
        ]
    }
}
