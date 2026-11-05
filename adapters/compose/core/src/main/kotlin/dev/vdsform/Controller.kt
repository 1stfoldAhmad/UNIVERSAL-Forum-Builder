package dev.vdsform

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred

/**
 * Headless form controller — Kotlin port of @vds-form/runtime. Conditions,
 * formulas, repeaters, validation, multi-step. Submission is delegated to an
 * injected trusted transport; the client never executes business operations.
 * Observable state is exposed via a simple listener list (Compose collects it).
 */

fun interface SubmissionTransport {
    suspend fun submit(formId: String, values: Map<String, Any?>, idempotencyKey: String): Map<String, Any?>
}

interface DraftAdapter {
    suspend fun save(formId: String, values: Map<String, Any?>)
    suspend fun load(formId: String): Map<String, Any?>?
    suspend fun clear(formId: String)
}

class UploadCancellation {
    @Volatile var isCancelled: Boolean = false; private set
    fun cancel() { isCancelled = true }
}

interface UploadAdapter {
    suspend fun upload(
        fieldPath: String, name: String, bytes: ByteArray, mimeType: String,
        onProgress: ((Double) -> Unit)? = null, cancellation: UploadCancellation? = null,
    ): Map<String, Any?>
}

/** A file selected by the host platform (SAF document picker, photo picker, camera). */
data class PickedFile(
    val name: String, val bytes: ByteArray, val mimeType: String? = null,
    val id: String? = null, val localUri: String? = null,
) { val size: Int get() = bytes.size }

/** Host-injected file/image selection; no picker dependency is bundled. */
interface FilePickerAdapter {
    suspend fun pick(image: Boolean, multiple: Boolean, accept: List<String>?): List<PickedFile>
}

/** Host-injected camera capture; separate so camera is only advertised when real. */
interface CameraAdapter {
    suspend fun capture(accept: List<String>?): PickedFile?
}

/** Host-injected barcode/QR scanner. */
interface BarcodeAdapter {
    suspend fun scan(): String?
}

data class UploadFailure(val name: String, val code: String, val message: String)
data class UploadBatchResult(val uploaded: List<Map<String, Any?>>, val failures: List<UploadFailure>, val cancelled: Boolean)
data class UploadState(
    val busy: Boolean = false, val fraction: Double = 0.0,
    val fileName: String? = null, val failures: List<UploadFailure> = emptyList(),
)

class FormController(
    val ir: Map<String, Any?>,
    initialValues: Map<String, Any?> = emptyMap(),
    val transport: SubmissionTransport? = null,
    val drafts: DraftAdapter? = null,
    val uploads: UploadAdapter? = null,
    val picker: FilePickerAdapter? = null,
    val camera: CameraAdapter? = null,
    val barcode: BarcodeAdapter? = null,
    var locale: String = (ir["localization"] as? Map<*, *>)?.get("defaultLocale") as? String ?: "en",
) {
    var values: Map<String, Any?> = LinkedHashMap(initialValues); private set
    var state = EffectiveState(); private set
    var issues: List<Map<String, Any?>> = emptyList(); private set
    val repeaterRows: MutableMap<String, MutableList<String>> = mutableMapOf()
    var stepIndex = 0
    var status = "idle"; private set
    var statusMessage: String? = null; private set
    private var rowSeq = 0
    private val listeners = ArrayList<() -> Unit>()

    /** Single active submission: concurrent submit() calls await the SAME attempt. */
    private var inFlight: Deferred<Map<String, Any?>>? = null
    private var attemptKey: String? = null
    private var attemptFingerprint: String? = null
    private var disposed = false
    val isSubmitting: Boolean get() = inFlight != null
    val isDisposed: Boolean get() = disposed

    val uploadStates: MutableMap<String, UploadState> = mutableMapOf()
    private val uploadCancellations = mutableMapOf<String, UploadCancellation>()
    private val seenUploadIdentities = HashSet<String>()
    var draftStatus = "idle"; private set
    var draftMessage: String? = null; private set

    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }
    private fun notifyListeners() { for (l in listeners.toList()) l() }

    @Suppress("UNCHECKED_CAST")
    fun initialize() {
        for (f in ir["fields"] as List<Map<String, Any?>>) {
            if (f["parentId"] != null || f["repeaterId"] != null) continue
            if (f.containsKey("defaultValue") && Expressions.getPath(values, f["key"] as String) == null)
                values = Validation.setIn(values, f["key"] as String, f["defaultValue"])
        }
        for (f in ir["fields"] as List<Map<String, Any?>>) {
            if (f["type"] != "repeater") continue
            val rows = Expressions.getPath(values, f["key"] as String)
            val list = if (rows is List<*>) ArrayList<Any?>(rows) else ArrayList()
            val min = ((f["validation"] as? Map<*, *>)?.get("minItems") ?: f["minItems"] ?: 0) as Number
            while (list.size < min.toInt()) list.add(LinkedHashMap<String, Any?>())
            values = Validation.setIn(values, f["key"] as String, list)
            repeaterRows[f["id"] as String] = MutableList(list.size) { "row-${rowSeq++}" }
        }
        recompute()
    }

    @Suppress("UNCHECKED_CAST")
    private fun recompute() {
        val formulas = (ir["formulas"] as? List<Map<String, Any?>> ?: emptyList())
        for (pass in 0..formulas.size) {
            var changed = false
            for (formula in formulas) {
                val target = formula["target"] as String
                if (target.contains("[]")) {
                    val repKey = target.split("[]").first().trimEnd('.')
                    val rows = Expressions.getPath(values, repKey)
                    val n = if (rows is List<*>) rows.size else 0
                    for (i in 0 until n) {
                        val concrete = target.replaceFirst("[]", ".$i")
                        val r = Expressions.evaluate(formula["expr"] as Map<String, Any?>, mapOf("values" to values, "rowPrefix" to "$repKey.$i", "rowIndex" to i))
                        if (r is ExprResult.Ok && Expressions.getPath(values, concrete) != r.value) { values = Validation.setIn(values, concrete, r.value); changed = true }
                    }
                } else {
                    val r = Expressions.evaluate(formula["expr"] as Map<String, Any?>, mapOf("values" to values))
                    if (r is ExprResult.Ok && Expressions.getPath(values, target) != r.value) { values = Validation.setIn(values, target, r.value); changed = true }
                }
            }
            if (!changed) break
        }
        state = Validation.computeEffectiveState(ir, values)
    }

    fun fieldValue(path: String): Any? = Expressions.getPath(values, path)

    fun setFieldValue(path: String, value: Any?) { values = Validation.setIn(values, path, value); recompute(); notifyListeners() }

    @Suppress("UNCHECKED_CAST")
    fun addRepeaterItem(repeaterId: String) {
        val f = (ir["fields"] as List<Map<String, Any?>>).first { it["id"] == repeaterId }
        val rows = ArrayList<Any?>((Expressions.getPath(values, f["key"] as String) as? List<*>) ?: emptyList<Any?>())
        rows.add(LinkedHashMap<String, Any?>())
        values = Validation.setIn(values, f["key"] as String, rows)
        repeaterRows.getOrPut(repeaterId) { mutableListOf() }.add("row-${rowSeq++}")
        recompute(); notifyListeners()
    }

    @Suppress("UNCHECKED_CAST")
    fun removeRepeaterItem(repeaterId: String, rowId: String) {
        val f = (ir["fields"] as List<Map<String, Any?>>).first { it["id"] == repeaterId }
        val ids = repeaterRows[repeaterId] ?: return
        val idx = ids.indexOf(rowId); if (idx < 0) return
        val rows = ArrayList<Any?>((Expressions.getPath(values, f["key"] as String) as? List<*>) ?: emptyList<Any?>())
        rows.removeAt(idx); ids.removeAt(idx)
        values = Validation.setIn(values, f["key"] as String, rows)
        recompute(); notifyListeners()
    }

    @Suppress("UNCHECKED_CAST")
    fun moveRepeaterItem(repeaterId: String, from: Int, to: Int) {
        val f = (ir["fields"] as List<Map<String, Any?>>).first { it["id"] == repeaterId }
        val rows = ArrayList<Any?>((Expressions.getPath(values, f["key"] as String) as? List<*>) ?: emptyList<Any?>())
        val ids = repeaterRows[repeaterId] ?: return
        if (from < 0 || to < 0 || from >= rows.size || to >= rows.size) return
        val item = rows.removeAt(from); rows.add(to, item)
        val id = ids.removeAt(from); ids.add(to, id)
        values = Validation.setIn(values, f["key"] as String, rows)
        recompute(); notifyListeners()
    }

    fun validate(): List<Map<String, Any?>> { issues = Validation.validateValues(ir, values, state, locale = locale); notifyListeners(); return issues }

    fun errorsFor(path: String): List<Map<String, Any?>> = issues.filter { it["path"] == path && it["severity"] == "error" }

    private fun stable(v: Any?): String = when (v) {
        is Map<*, *> -> v.keys.map { it.toString() }.sorted().joinToString(",", "{", "}") { "$it:${stable(v[it])}" }
        is List<*> -> v.joinToString(",", "[", "]") { stable(it) }
        else -> v?.toString() ?: "null"
    }

    private fun fingerprint(): String = values.keys.sorted().joinToString(";") { "$it=${stable(values[it])};" }

    suspend fun submit(): Map<String, Any?> {
        if (disposed) return mapOf("status" to "config-error", "code" to "DISPOSED")
        // One active attempt: a second rapid tap awaits the first, never re-executes.
        inFlight?.let { return it.await() }

        val found = validate()
        if (found.any { it["severity"] == "error" }) {
            status = "invalid"; statusMessage = "Please correct the errors below."; notifyListeners()
            return mapOf("status" to "server-validation-failed", "issues" to found)
        }
        val t = transport ?: run {
            status = "failed"; statusMessage = "No submission transport configured."; notifyListeners()
            return mapOf("status" to "config-error", "code" to "NO_TRANSPORT")
        }

        val fp = fingerprint()
        // Reuse the key only for an unresolved attempt with an UNCHANGED payload.
        val key = if (attemptKey != null && attemptFingerprint == fp) attemptKey!!
                  else "compose-${System.currentTimeMillis()}-${rowSeq++}"
        attemptKey = key; attemptFingerprint = fp

        status = "submitting"; notifyListeners()
        val deferred = CompletableDeferred<Map<String, Any?>>()
        inFlight = deferred
        val result = try {
            val r = t.submit(ir["formId"] as String, values, key)
            if (!disposed) {
                // A definitive verdict resolves the attempt: next submit is a new key.
                attemptKey = null; attemptFingerprint = null
                val st = r["status"]
                status = if (st == "succeeded") "succeeded" else "failed"
                statusMessage = if (st == "succeeded") "Submitted successfully." else (r["message"] as? String ?: st as? String ?: "failed")
                @Suppress("UNCHECKED_CAST")
                if (st == "server-validation-failed" && r["issues"] is List<*>) issues = r["issues"] as List<Map<String, Any?>>
                notifyListeners()
            }
            r
        } catch (e: Exception) {
            // Unresolved: keep the key so retrying the SAME payload replays safely.
            if (!disposed) { status = "failed"; statusMessage = e.toString(); notifyListeners() }
            mapOf("status" to "config-error", "message" to e.toString())
        }
        deferred.complete(result)
        inFlight = null
        return result
    }

    // ---------------------------------------------------------------- uploads

    @Suppress("UNCHECKED_CAST")
    private fun refsAt(path: String): List<Map<String, Any?>> {
        val cur = Expressions.getPath(values, path)
        return when (cur) {
            is List<*> -> cur.filterIsInstance<Map<String, Any?>>()
            is Map<*, *> -> listOf(cur as Map<String, Any?>)
            else -> emptyList()
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun fieldForPath(path: String): Map<String, Any?>? {
        for (f in ir["fields"] as List<Map<String, Any?>>) {
            val key = f["key"] as? String ?: continue
            if (key == path) return f
            if (key.contains("[]") && path.startsWith(key.substringBefore("[]"))) return f
        }
        return null
    }

    /** Shared upload-batch semantics; mirrors @vds-form/runtime uploadAssetBatch. */
    suspend fun uploadFiles(path: String, files: List<PickedFile>, source: String = "picker"): UploadBatchResult {
        val field = fieldForPath(path)
        val v = (field?.get("validation") as? Map<*, *>) ?: emptyMap<String, Any?>()
        val multiple = v["multiple"] == true || field?.get("valueType") == "asset[]"
        val accept = (v["accept"] as? List<*>)?.map { it.toString() }
        val maxSize = v["maxSizeBytes"] as? Number
        val failures = ArrayList<UploadFailure>()
        val uploaded = ArrayList<Map<String, Any?>>()

        val u = uploads ?: return UploadBatchResult(uploaded,
            listOf(UploadFailure(files.firstOrNull()?.name ?: "", "UPLOAD_PROVIDER_MISSING", "No upload adapter registered.")), false)
        if (files.isEmpty()) return UploadBatchResult(uploaded, failures, false)

        val batch = if (multiple) files else files.take(1)
        if (!multiple) for (extra in files.drop(1)) failures.add(UploadFailure(extra.name, "MULTIPLE_NOT_ALLOWED", "Only one file is allowed."))

        for (r in refsAt(path)) (r["assetRef"] as? String)?.let { if (it.isNotEmpty()) seenUploadIdentities.add("ref:$it") }

        val cancel = UploadCancellation()
        uploadCancellations[path] = cancel
        uploadStates[path] = UploadState(busy = true, fileName = batch.first().name, failures = failures.toList())
        notifyListeners()

        for (f in batch) {
            if (cancel.isCancelled || disposed) break
            if (!Assets.sizeAllowed(f.size, maxSize)) { failures.add(UploadFailure(f.name, "ASSET_TOO_LARGE", "File exceeds $maxSize bytes.")); continue }
            if (!Assets.typeAllowed(f.name, f.mimeType, accept)) { failures.add(UploadFailure(f.name, "ASSET_TYPE_REJECTED", "File type ${f.mimeType ?: f.name} is not allowed.")); continue }
            val identity = Assets.uploadIdentity(id = f.id, localUri = f.localUri, name = f.name, size = f.size)
            if (identity != null && seenUploadIdentities.contains(identity)) continue
            try {
                val ref = u.upload(path, f.name, f.bytes, f.mimeType ?: "application/octet-stream",
                    onProgress = { fraction ->
                        if (!disposed && !cancel.isCancelled) {
                            uploadStates[path] = UploadState(true, fraction, f.name, failures.toList()); notifyListeners()
                        }
                    },
                    cancellation = cancel)
                // Never commit a cancelled/disposed batch even if the adapter resolved.
                if (cancel.isCancelled || disposed) break
                if (identity != null) seenUploadIdentities.add(identity)
                uploaded.add(ref)
                if (multiple) {
                    val live = ArrayList(refsAt(path))
                    if (live.none { it["assetRef"] == ref["assetRef"] }) live.add(ref)
                    setFieldValue(path, live)
                } else setFieldValue(path, ref)
            } catch (e: Exception) {
                if (cancel.isCancelled || disposed) break
                failures.add(UploadFailure(f.name, "UPLOAD_FAILED", e.toString()))
            }
        }

        val cancelled = cancel.isCancelled
        uploadCancellations.remove(path)
        if (!disposed) { uploadStates[path] = UploadState(false, 1.0, null, failures.toList()); notifyListeners() }
        return UploadBatchResult(uploaded, failures, cancelled)
    }

    suspend fun pickAndUpload(path: String, useCamera: Boolean = false): UploadBatchResult {
        val field = fieldForPath(path) ?: return UploadBatchResult(emptyList(), emptyList(), false)
        val v = (field["validation"] as? Map<*, *>) ?: emptyMap<String, Any?>()
        val multiple = v["multiple"] == true || field["valueType"] == "asset[]"
        val accept = (v["accept"] as? List<*>)?.map { it.toString() }
        if (useCamera) {
            val cam = camera ?: return UploadBatchResult(emptyList(),
                listOf(UploadFailure("", "UPLOAD_PROVIDER_MISSING", "No camera adapter registered.")), false)
            val shot = cam.capture(accept)
            if (disposed || shot == null) return UploadBatchResult(emptyList(), emptyList(), shot == null)
            return uploadFiles(path, listOf(shot), "camera")
        }
        val p = picker ?: return UploadBatchResult(emptyList(),
            listOf(UploadFailure("", "UPLOAD_PROVIDER_MISSING", "No file picker adapter registered.")), false)
        val picked = p.pick(field["type"] == "image", multiple, accept)
        if (disposed) return UploadBatchResult(emptyList(), emptyList(), true)
        return uploadFiles(path, picked)
    }

    fun cancelUpload(path: String) { uploadCancellations[path]?.cancel() }
    fun uploadStateFor(path: String): UploadState = uploadStates[path] ?: UploadState()

    // ----------------------------------------------------------------- drafts

    suspend fun saveDraft() {
        val d = drafts ?: run { draftStatus = "unavailable"; draftMessage = "No draft adapter registered."; notifyListeners(); return }
        try { d.save(ir["formId"] as String, values); if (!disposed) { draftStatus = "saved"; draftMessage = null; notifyListeners() } }
        catch (e: Exception) { if (!disposed) { draftStatus = "failed"; draftMessage = e.toString(); notifyListeners() } }
    }

    suspend fun restoreDraft(): Boolean {
        val d = drafts ?: run { draftStatus = "unavailable"; notifyListeners(); return false }
        return try {
            val saved = d.load(ir["formId"] as String)
            if (disposed) false
            else if (saved == null) { draftStatus = "empty"; notifyListeners(); false }
            else {
                values = LinkedHashMap(saved); recompute()
                draftStatus = "restored"; draftMessage = null; notifyListeners(); true
            }
        } catch (e: Exception) {
            if (!disposed) { draftStatus = "failed"; draftMessage = e.toString(); notifyListeners() }
            false
        }
    }

    suspend fun clearDraft() {
        val d = drafts ?: run { draftStatus = "unavailable"; notifyListeners(); return }
        try { d.clear(ir["formId"] as String); if (!disposed) { draftStatus = "cleared"; draftMessage = null; notifyListeners() } }
        catch (e: Exception) { if (!disposed) { draftStatus = "failed"; draftMessage = e.toString(); notifyListeners() } }
    }

    /** Releases listeners and cancels in-flight uploads (no post-dispose writes). */
    fun dispose() {
        if (disposed) return
        disposed = true
        for (c in uploadCancellations.values) c.cancel()
        uploadCancellations.clear()
        listeners.clear()
    }
}
