package dev.vdsform

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Native upload lifecycle + single-active-submission guarantees (mission §3.4,
 * §4.5) and the shared cross-language asset conformance fixture (§3.2, §10).
 */
class UploadSubmissionTest {
    private fun fixtureDir() = System.getenv("VDS_CONFORMANCE_FIXTURES") ?: "../../../packages/form-conformance/fixtures"

    private fun uploadIr(multiple: Boolean = true, accept: List<String>? = null, maxSize: Int? = null): Map<String, Any?> {
        val validation = LinkedHashMap<String, Any?>()
        if (multiple) validation["multiple"] = true
        if (accept != null) validation["accept"] = accept
        if (maxSize != null) validation["maxSizeBytes"] = maxSize
        return mapOf(
            "formId" to "test:uploads", "specVersion" to "1.0.0",
            "fields" to listOf(
                mapOf("id" to "doc", "key" to "doc", "type" to "file", "label" to "Document",
                      "valueType" to if (multiple) "asset[]" else "asset", "validation" to validation),
                mapOf("id" to "note", "key" to "note", "type" to "text", "label" to "Note", "valueType" to "string"),
            ),
            "layout" to mapOf("type" to "section", "fieldRefs" to listOf("doc", "note")),
            "formulas" to emptyList<Any?>(), "conditions" to emptyList<Any?>(),
        )
    }

    private class FakeUpload(
        val failFor: Set<String> = emptySet(),
        val ignoreCancel: Boolean = false,
        val gate: CompletableDeferred<Unit>? = null,
    ) : UploadAdapter {
        val calls = ArrayList<String>()
        var seq = 0
        override suspend fun upload(
            fieldPath: String, name: String, bytes: ByteArray, mimeType: String,
            onProgress: ((Double) -> Unit)?, cancellation: UploadCancellation?,
        ): Map<String, Any?> {
            calls.add(name)
            onProgress?.invoke(0.5)
            gate?.await()
            if (failFor.contains(name)) throw RuntimeException("boom")
            if (cancellation?.isCancelled == true && !ignoreCancel) throw RuntimeException("UPLOAD_CANCELLED")
            seq++
            return mapOf("assetRef" to "ref-$seq", "name" to name, "mimeType" to mimeType, "sizeBytes" to bytes.size)
        }
    }

    private class MemoryDrafts : DraftAdapter {
        val store = HashMap<String, Map<String, Any?>>()
        override suspend fun save(formId: String, values: Map<String, Any?>) { store[formId] = LinkedHashMap(values) }
        override suspend fun load(formId: String): Map<String, Any?>? = store[formId]
        override suspend fun clear(formId: String) { store.remove(formId) }
    }

    private fun pf(name: String, size: Int = 3, mime: String? = "application/pdf", id: String? = null) =
        PickedFile(name, ByteArray(size) { 65 }, mime, id)

    @Test
    fun `Kotlin matches every shared asset conformance case`() {
        val type = object : TypeToken<Map<String, Any?>>() {}.type
        val suite: Map<String, Any?> = Gson().fromJson(File("${fixtureDir()}/asset-upload.json").readText(), type)
        val failures = ArrayList<String>()
        @Suppress("UNCHECKED_CAST")
        for (c in suite["cases"] as List<Map<String, Any?>>) {
            @Suppress("UNCHECKED_CAST")
            val expect = c["expect"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val accept = (c["accept"] as List<*>).map { it.toString() }
            val gotType = Assets.typeAllowed(c["name"] as? String, c["mimeType"] as? String, accept)
            val gotSize = Assets.sizeAllowed(c["sizeBytes"], c["maxSizeBytes"] as? Number)
            if (gotType != expect["typeAllowed"]) failures.add("${c["id"]}: type $gotType != ${expect["typeAllowed"]}")
            if (gotSize != expect["sizeAllowed"]) failures.add("${c["id"]}: size $gotSize != ${expect["sizeAllowed"]}")
        }
        assertTrue(failures.isEmpty(), failures.joinToString(" | "))
    }

    @Test
    fun `extension helpers are canonical`() {
        assertEquals("jpeg", Assets.fileExtension("photo.JPG"))
        assertEquals("image/jpeg", Assets.normalizeMimeType("image/jpg"))
        assertTrue(Assets.typeAllowed("p.jpg", "image/jpeg", listOf(".jpg")))
        assertFalse(Assets.typeAllowed("p.png", "image/png", listOf(".jpg")))
    }

    @Test
    fun `two rapid submit calls execute the transport ONCE`() = runBlocking {
        val gate = CompletableDeferred<Map<String, Any?>>()
        var executions = 0
        val keys = ArrayList<String>()
        val c = FormController(uploadIr(), transport = { _, _, key ->
            executions++
            keys.add(key)
            gate.await()
        })
        c.initialize()

        val a = async { c.submit() }
        val b = async { c.submit() }
        // Let both coroutines reach the guard before completing the transport.
        kotlinx.coroutines.yield()
        assertEquals(1, executions, "a second tap must not start a second transport execution")
        gate.complete(mapOf("status" to "succeeded"))
        assertEquals("succeeded", a.await()["status"])
        assertEquals("succeeded", b.await()["status"])
        assertEquals(1, executions)
        assertEquals(1, keys.size)
        assertFalse(c.isSubmitting)
        assertEquals("succeeded", c.status)
    }

    @Test
    fun `an unresolved attempt reuses its key but an edited payload does not`() = runBlocking {
        val keys = ArrayList<String>()
        var fail = true
        val c = FormController(uploadIr(), transport = { _, _, key ->
            keys.add(key)
            if (fail) throw RuntimeException("network down")
            mapOf("status" to "succeeded")
        })
        c.initialize()
        c.submit()
        assertEquals("failed", c.status)
        c.submit()
        assertEquals(keys[0], keys[1], "same unresolved payload must replay the same idempotency key")
        c.setFieldValue("note", "edited")
        fail = false
        c.submit()
        assertNotEquals(keys[1], keys[2], "an edited payload must not reuse the old key")
    }

    @Test
    fun `a definitive server verdict resolves the attempt`() = runBlocking {
        val keys = ArrayList<String>()
        val c = FormController(uploadIr(), transport = { _, _, key ->
            keys.add(key); mapOf("status" to "business-rejected", "message" to "no")
        })
        c.initialize()
        c.submit(); c.submit()
        assertNotEquals(keys[0], keys[1])
    }

    @Test
    fun `no transport yields config-error`() = runBlocking {
        val c = FormController(uploadIr())
        c.initialize()
        val r = c.submit()
        assertEquals("config-error", r["status"])
        assertEquals("NO_TRANSPORT", r["code"])
    }

    @Test
    fun `partial success is preserved when a later file fails`() = runBlocking {
        val up = FakeUpload(failFor = setOf("bad.pdf"))
        val c = FormController(uploadIr(), uploads = up)
        c.initialize()
        val r = c.uploadFiles("doc", listOf(pf("ok.pdf"), pf("bad.pdf"), pf("ok2.pdf")))
        assertEquals(2, r.uploaded.size)
        assertEquals("UPLOAD_FAILED", r.failures.single().code)
        assertEquals(2, (c.fieldValue("doc") as List<*>).size)
    }

    @Test
    fun `canonical constraints reject oversized and wrong-type files`() = runBlocking {
        val up = FakeUpload()
        val c = FormController(uploadIr(accept = listOf(".jpg"), maxSize = 5), uploads = up)
        c.initialize()
        val r = c.uploadFiles("doc", listOf(
            pf("big.jpg", size = 9, mime = "image/jpeg"),
            pf("a.png", mime = "image/png"),
            pf("ok.jpg", mime = "image/jpeg"),
        ))
        assertEquals(listOf("ASSET_TOO_LARGE", "ASSET_TYPE_REJECTED"), r.failures.map { it.code })
        assertEquals(1, r.uploaded.size)
    }

    @Test
    fun `jpg is accepted against a jpg accept token`() = runBlocking {
        val up = FakeUpload()
        val c = FormController(uploadIr(accept = listOf(".jpg")), uploads = up)
        c.initialize()
        val r = c.uploadFiles("doc", listOf(pf("photo.jpg", mime = "image/jpeg")))
        assertTrue(r.failures.isEmpty())
        assertEquals(listOf("photo.jpg"), up.calls)
    }

    @Test
    fun `same identity is not uploaded twice and unidentified duplicates are kept`() = runBlocking {
        val up = FakeUpload()
        val c = FormController(uploadIr(), uploads = up)
        c.initialize()
        c.uploadFiles("doc", listOf(pf("a.pdf", id = "n1")))
        c.uploadFiles("doc", listOf(pf("a.pdf", id = "n1")))
        assertEquals(1, up.calls.size)
        c.uploadFiles("doc", listOf(pf("same.pdf"), pf("same.pdf")))
        assertEquals(3, (c.fieldValue("doc") as List<*>).size)
    }

    @Test
    fun `cancelling mid-transfer keeps committed refs and drops the cancelled one`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val up = FakeUpload(gate = gate)
        val c = FormController(uploadIr(), uploads = up)
        c.initialize()
        c.uploadFiles("doc", listOf(pf("first.pdf")))
        val pending = async { c.uploadFiles("doc", listOf(pf("second.pdf"))) }
        kotlinx.coroutines.yield()
        c.cancelUpload("doc")
        gate.complete(Unit)
        val r = pending.await()
        assertTrue(r.cancelled)
        val refs = c.fieldValue("doc") as List<*>
        assertEquals(1, refs.size, "the cancelled upload must not be committed")
        assertEquals("first.pdf", (refs[0] as Map<*, *>)["name"])
    }

    @Test
    fun `a provider that ignores cancellation still cannot commit`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val up = FakeUpload(gate = gate, ignoreCancel = true)
        val c = FormController(uploadIr(), uploads = up)
        c.initialize()
        val pending = async { c.uploadFiles("doc", listOf(pf("a.pdf"))) }
        kotlinx.coroutines.yield()
        c.cancelUpload("doc")
        gate.complete(Unit)
        assertTrue(pending.await().cancelled)
        assertEquals(null, c.fieldValue("doc"))
    }

    @Test
    fun `no upload adapter reports UPLOAD_PROVIDER_MISSING`() = runBlocking {
        val c = FormController(uploadIr())
        c.initialize()
        assertEquals("UPLOAD_PROVIDER_MISSING", c.uploadFiles("doc", listOf(pf("a.pdf"))).failures.single().code)
    }

    @Test
    fun `single-value field rejects extra files`() = runBlocking {
        val c = FormController(uploadIr(multiple = false), uploads = FakeUpload())
        c.initialize()
        val r = c.uploadFiles("doc", listOf(pf("a.pdf"), pf("b.pdf")))
        assertEquals("MULTIPLE_NOT_ALLOWED", r.failures.single().code)
        assertTrue(c.fieldValue("doc") is Map<*, *>)
    }

    @Test
    fun `dispose cancels in-flight uploads and stops notifications`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val c = FormController(uploadIr(), uploads = FakeUpload(gate = gate))
        c.initialize()
        var notifications = 0
        c.addListener { notifications++ }
        val pending = async { c.uploadFiles("doc", listOf(pf("a.pdf"))) }
        kotlinx.coroutines.yield()
        c.dispose()
        val before = notifications
        gate.complete(Unit)
        assertTrue(pending.await().cancelled)
        assertTrue(c.isDisposed)
        assertEquals(before, notifications, "no notifications after dispose")
    }

    @Test
    fun `drafts save restore and clear round-trip`() = runBlocking {
        val drafts = MemoryDrafts()
        val c = FormController(uploadIr(), drafts = drafts)
        c.initialize()
        c.setFieldValue("note", "hello")
        c.saveDraft()
        assertEquals("saved", c.draftStatus)

        val c2 = FormController(uploadIr(), drafts = drafts)
        c2.initialize()
        assertTrue(c2.restoreDraft())
        assertEquals("hello", c2.fieldValue("note"))
        assertEquals("restored", c2.draftStatus)

        c2.clearDraft()
        assertEquals("cleared", c2.draftStatus)
        val c3 = FormController(uploadIr(), drafts = drafts)
        c3.initialize()
        assertFalse(c3.restoreDraft())
        assertEquals("empty", c3.draftStatus)
    }

    @Test
    fun `without an adapter draft status is unavailable`() = runBlocking {
        val c = FormController(uploadIr())
        c.initialize()
        c.saveDraft()
        assertEquals("unavailable", c.draftStatus)
    }
}
