package dev.vdsform

/** Renderer capability manifest for the Compose target (shared contract). */
object Capabilities {
    val SUPPORTED = listOf(
        "text", "textarea", "email", "password", "url", "phone", "integer", "decimal",
        "currency", "percentage", "duration", "date", "time", "datetime", "select",
        "multiselect", "radio", "checkbox", "switch", "consent", "rating", "range",
        "color", "file", "image", "computed", "hidden", "group", "repeater", "barcode",
    )

    fun manifest(): Map<String, Any?> = mapOf(
        "target" to "compose",
        "contractVersion" to "1.0.0",
        "fieldTypes" to SUPPORTED.associateWith { mapOf("fieldType" to it, "supported" to true) },
        "features" to mapOf(
            "dragDrop" to false, "filePicker" to true, "camera" to true, "offlineQueue" to true,
            "draftPersistence" to true, "multiStep" to true, "repeaters" to true, "richText" to false, "signature" to false,
        ),
    )
}
