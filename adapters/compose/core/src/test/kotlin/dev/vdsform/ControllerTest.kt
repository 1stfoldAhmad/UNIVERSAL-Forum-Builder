package dev.vdsform

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ControllerTest {
    private fun loadIr(name: String): Map<String, Any?> {
        val base = System.getenv("VDS_IR_FIXTURES") ?: "../../../execution-adapters/laravel/tests/fixtures/ir"
        val type = object : TypeToken<Map<String, Any?>>() {}.type
        return Gson().fromJson(File("$base/$name.ir.json").readText(), type)
    }

    @Test
    fun `formulas compute row-scoped and global totals`() {
        val c = FormController(loadIr("invoice"), mapOf("items" to listOf(
            mapOf("description" to "A", "qty" to 2, "price" to 5),
            mapOf("description" to "B", "qty" to 3, "price" to 4),
        )))
        c.initialize()
        assertEquals(10L, c.fieldValue("items.0.lineTotal"))
        assertEquals(22L, c.fieldValue("subtotal"))
        assertNotNull(c.fieldValue("total"))
    }

    @Test
    fun `conditions toggle visibility and required`() {
        val c = FormController(loadIr("customer-registration"))
        c.initialize()
        assertEquals(false, c.state.visibility["companyName"])
        c.setFieldValue("customer.type", "business")
        assertEquals(true, c.state.visibility["companyName"])
        assertEquals(true, c.state.required["companyName"])
    }

    @Test
    fun `repeaters add and remove rows`() {
        val c = FormController(loadIr("invoice"))
        c.initialize()
        val before = (c.fieldValue("items") as List<*>).size
        c.addRepeaterItem("items")
        assertEquals(before + 1, (c.fieldValue("items") as List<*>).size)
        val rowId = c.repeaterRows["items"]!!.last()
        c.removeRepeaterItem("items", rowId)
        assertEquals(before, (c.fieldValue("items") as List<*>).size)
    }

    @Test
    fun `validation reports required and submit blocks`() = runBlocking {
        val c = FormController(loadIr("customer-registration"))
        c.initialize()
        val issues = c.validate()
        assertTrue(issues.any { it["code"] == "REQUIRED" })
        val result = c.submit()
        assertEquals("server-validation-failed", result["status"])
    }

    @Test
    fun `concurrent submits share one execution and same payload retries reuse key`() = runBlocking {
        var calls = 0
        val keys = mutableListOf<String>()
        val gate = CompletableDeferred<Map<String, Any?>>()
        val c = FormController(
            loadIr("customer-registration"),
            mapOf("customer" to mapOf("name" to "Ada Lovelace", "email" to "ada@example.com", "type" to "individual", "consent" to true)),
            transport = SubmissionTransport { _, _, key ->
                calls++; keys.add(key)
                if (calls == 1) gate.await() else mapOf("status" to "succeeded")
            },
        )
        c.initialize()
        val first = async { c.submit() }
        yield()
        val concurrent = c.submit()
        assertEquals("SUBMISSION_IN_PROGRESS", concurrent["code"])
        assertEquals(1, calls)
        gate.complete(mapOf("status" to "business-rejected"))
        first.await()
        c.submit()
        assertEquals(2, calls)
        assertEquals(keys[0], keys[1])
    }

    @Test
    fun `submit delegates to injected trusted transport`() = runBlocking {
        var sent: Map<String, Any?>? = null
        val c = FormController(
            loadIr("customer-registration"),
            mapOf("customer" to mapOf("name" to "Ada Lovelace", "email" to "ada@example.com", "type" to "individual", "consent" to true)),
            transport = SubmissionTransport { _, values, _ -> sent = values; mapOf("status" to "succeeded") },
        )
        c.initialize()
        val result = c.submit()
        assertEquals("succeeded", result["status"])
        assertNotNull(sent)
        assertEquals("succeeded", c.status)
    }

    @Test
    fun `capability manifest covers registry minus signature`() {
        val m = Capabilities.manifest()
        assertEquals("compose", m["target"])
        @Suppress("UNCHECKED_CAST")
        val ft = m["fieldTypes"] as Map<String, Any?>
        assertTrue(ft.containsKey("text"))
        assertEquals("partial", (ft["text"] as Map<*, *>)["status"])
        assertEquals("unsupported", (ft["signature"] as Map<*, *>)["status"])
        @Suppress("UNCHECKED_CAST")
        val features = m["features"] as Map<String, Map<String, String>>
        assertEquals("unsupported", features["camera"]?.get("status"))
        assertEquals("unsupported", features["offlineQueue"]?.get("status"))
    }
}
