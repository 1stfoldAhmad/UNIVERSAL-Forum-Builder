package dev.vdsform

/**
 * Renderer capability manifest for the Compose target (shared contract).
 *
 * HONESTY RULE: `supported` only when implemented, wired, tested AND usable.
 * Anything needing a host plugin is `requires-host-adapter`, never `supported`.
 * The JSON mirror specifications/capabilities/compose.json is asserted equal to
 * this map by CapabilitiesTest, so docs cannot drift from code.
 */
object Capabilities {
    val SUPPORTED = listOf(
        "text", "textarea", "email", "password", "url", "phone", "integer", "decimal",
        "currency", "percentage", "duration", "date", "time", "datetime", "select",
        "multiselect", "radio", "checkbox", "switch", "consent", "rating", "range",
        "color", "file", "image", "computed", "hidden", "group", "repeater", "barcode",
    )

    val LAYOUT_NODES = listOf(
        "section", "group", "row", "columns", "tabs", "tab", "accordion", "steps",
        "step", "fieldset", "summary", "repeater", "divider", "text",
    )

    private fun sup() = mapOf("status" to "supported")
    private fun unsupported(reason: String) = mapOf("status" to "unsupported", "reason" to reason)
    private fun host(reason: String, vararg requires: String) =
        mapOf("status" to "requires-host-adapter", "requires" to requires.toList(), "reason" to reason)

    fun manifest(): Map<String, Any?> = mapOf(
        "target" to "compose",
        "contractVersion" to "1.0.0",
        "fieldTypes" to SUPPORTED.associateWith { mapOf("fieldType" to it, "supported" to true) },
        "features" to mapOf(
            "dragDrop" to false, "filePicker" to false, "camera" to false, "offlineQueue" to false,
            "draftPersistence" to false, "multiStep" to true, "repeaters" to true,
            "richText" to false, "signature" to false,
        ),
        "featureStatus" to mapOf(
            "multiStep" to sup(), "repeaters" to sup(),
            "localization" to sup(), "accessibility" to sup(),
            "submissionGuard" to sup(), "uploadProgress" to sup(), "uploadCancel" to sup(),
            "filePicker" to host(
                "Renderer wires selection, progress, cancel and asset refs; no picker dependency is bundled.",
                "FilePickerAdapter", "UploadAdapter",
            ),
            "camera" to host("Capture is delegated to a host camera adapter.", "CameraAdapter", "UploadAdapter"),
            "barcode" to host("Scanning is delegated to a host scanner adapter.", "BarcodeAdapter"),
            "draftPersistence" to host("save/restore/clear implemented; durable storage is host-supplied.", "DraftAdapter"),
            "offlineQueue" to unsupported("No offline submission queue is implemented on this target."),
            "dragDrop" to unsupported("No drag-and-drop source on Android Compose."),
            "richText" to unsupported("No rich-text editor is implemented."),
            "signature" to unsupported("No signature pad is implemented; the control states this explicitly."),
        ),
        "fieldStatus" to mapOf(
            "file" to mapOf("status" to "requires-host-adapter", "requires" to listOf("FilePickerAdapter", "UploadAdapter")),
            "image" to mapOf("status" to "requires-host-adapter", "requires" to listOf("FilePickerAdapter", "UploadAdapter")),
            "barcode" to mapOf("status" to "requires-host-adapter", "requires" to listOf("BarcodeAdapter")),
            "signature" to unsupported("No signature pad is implemented."),
            "color" to mapOf("status" to "supported", "reason" to "Fixed accessible palette plus hex readout."),
            "date" to sup(), "time" to sup(), "datetime" to sup(),
            "multiselect" to sup(), "radio" to sup(),
        ),
        "layoutStatus" to LAYOUT_NODES.associateWith { sup() },
        "evidence" to mapOf(
            "unit" to "gradle :core:test (adapters/compose)",
            "ci" to ".github/workflows/ci.yml job: compose",
            "device" to "pending — no physical-device verification performed",
        ),
    )
}
