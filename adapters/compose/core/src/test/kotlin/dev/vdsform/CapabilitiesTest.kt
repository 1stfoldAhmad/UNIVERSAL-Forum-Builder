package dev.vdsform

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The checked-in JSON mirror must equal the language-native manifest, so the
 * generated support matrix can never drift from what the renderer declares.
 */
class CapabilitiesTest {
    private fun mirror(): Map<String, Any?> {
        val base = System.getenv("VDS_CAPABILITIES") ?: "../../../specifications/capabilities"
        val type = object : TypeToken<Map<String, Any?>>() {}.type
        return Gson().fromJson(File("$base/compose.json").readText(), type)
    }

    @Test
    fun `compose manifest matches the checked-in mirror`() {
        // Gson decodes JSON numbers as Double; normalise the manifest the same way
        // so the comparison is about structure and content, not numeric boxing.
        val gson = Gson()
        val type = object : TypeToken<Map<String, Any?>>() {}.type
        val normalised: Map<String, Any?> = gson.fromJson(gson.toJson(Capabilities.manifest()), type)
        assertEquals(mirror(), normalised)
    }

    @Test
    fun `every canonical layout node is declared`() {
        assertEquals(14, Capabilities.LAYOUT_NODES.size)
        @Suppress("UNCHECKED_CAST")
        val declared = (Capabilities.manifest()["layoutStatus"] as Map<String, Any?>).keys
        assertEquals(Capabilities.LAYOUT_NODES.toSet(), declared)
    }

    @Test
    fun `boolean shorthand agrees with the explicit status`() {
        @Suppress("UNCHECKED_CAST")
        val features = Capabilities.manifest()["features"] as Map<String, Boolean>
        @Suppress("UNCHECKED_CAST")
        val statuses = Capabilities.manifest()["featureStatus"] as Map<String, Map<String, Any?>>
        for ((key, value) in features) {
            val detail = statuses[key] ?: error("feature $key has no explicit status")
            assertEquals(detail["status"] == "supported", value, "feature $key boolean disagrees with its status")
        }
    }

    @Test
    fun `host-dependent capabilities are never advertised as supported`() {
        @Suppress("UNCHECKED_CAST")
        val statuses = Capabilities.manifest()["featureStatus"] as Map<String, Map<String, Any?>>
        for (key in listOf("filePicker", "camera", "barcode", "draftPersistence")) {
            assertEquals("requires-host-adapter", statuses[key]?.get("status"))
            assertTrue((statuses[key]?.get("requires") as List<*>).isNotEmpty())
        }
        assertEquals("unsupported", statuses["offlineQueue"]?.get("status"))
        assertEquals("unsupported", statuses["signature"]?.get("status"))
        assertFalse(Capabilities.SUPPORTED.contains("signature"))
    }
}
