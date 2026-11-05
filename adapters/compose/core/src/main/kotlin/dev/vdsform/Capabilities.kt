package dev.vdsform

/** Conservative capability manifest. Partial entries are not full conformance claims. */
object Capabilities {
    private val fieldTypes = listOf(
        "text", "textarea", "email", "password", "url", "phone", "integer", "decimal",
        "currency", "percentage", "duration", "date", "time", "datetime", "select",
        "multiselect", "radio", "checkbox", "switch", "consent", "rating", "range",
        "color", "file", "image", "computed", "hidden", "group", "repeater", "barcode", "signature",
    )

    private fun status(value: String): Map<String, String> = mapOf("status" to value)

    fun manifest(): Map<String, Any?> = mapOf(
        "target" to "compose",
        "contractVersion" to "1.0.0",
        "fieldTypes" to fieldTypes.associateWith { type ->
            status(when (type) {
                "hidden" -> "supported"
                "file", "image", "signature" -> "unsupported"
                else -> "partial"
            })
        },
        "features" to mapOf(
            "dragDrop" to status("unsupported"),
            "filePicker" to status("unsupported"),
            "camera" to status("unsupported"),
            "upload" to status("requires-host-adapter"),
            "offlineQueue" to status("unsupported"),
            "draftPersistence" to status("unsupported"),
            "multiStep" to status("partial"),
            "repeaters" to status("partial"),
            "dynamicOptions" to status("partial"),
            "layout" to status("partial"),
            "localization" to status("partial"),
            "accessibility" to status("partial"),
            "signature" to status("unsupported"),
            "barcode" to status("partial"),
        ),
    )
}
