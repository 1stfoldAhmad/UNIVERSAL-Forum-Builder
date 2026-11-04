package dev.vdsform

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

class ExprConformanceTest {
    @Test
    fun `vds expr 1 cross-language conformance`() {
        val fixtures = System.getenv("VDS_CONFORMANCE_FIXTURES") ?: "../../../packages/form-conformance/fixtures"
        val json = File("$fixtures/expressions.json").readText()
        val type = object : TypeToken<Map<String, Any?>>() {}.type
        val suite: Map<String, Any?> = Gson().fromJson(json, type)
        @Suppress("UNCHECKED_CAST")
        val cases = suite["cases"] as List<Map<String, Any?>>
        val failures = ArrayList<String>()
        for (c in cases) {
            @Suppress("UNCHECKED_CAST")
            val scope = (c["scope"] as? Map<String, Any?>) ?: emptyMap()
            @Suppress("UNCHECKED_CAST")
            val expr = c["expr"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val expect = c["expect"] as Map<String, Any?>
            val result = Expressions.evaluate(expr, scope)
            if (expect["ok"] == true) {
                if (result !is ExprResult.Ok) { failures.add("${c["id"]}: expected ok, got ${(result as ExprResult.Err).code}"); continue }
                if (!Expressions.deepEqual(result.value, expect["value"])) failures.add("${c["id"]}: expected ${expect["value"]}, got ${result.value}")
            } else {
                if (result is ExprResult.Ok) { failures.add("${c["id"]}: expected error ${expect["code"]}, got ok ${result.value}"); continue }
                if ((result as ExprResult.Err).code != expect["code"]) failures.add("${c["id"]}: expected ${expect["code"]}, got ${result.code}")
            }
        }
        assertTrue(failures.isEmpty(), "${cases.size} cases, failures:\n" + failures.joinToString("\n"))
    }
}
