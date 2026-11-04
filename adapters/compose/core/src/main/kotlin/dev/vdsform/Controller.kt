package dev.vdsform

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

interface UploadAdapter {
    suspend fun upload(fieldPath: String, name: String, bytes: ByteArray, mimeType: String): Map<String, Any?>
}

class FormController(
    val ir: Map<String, Any?>,
    initialValues: Map<String, Any?> = emptyMap(),
    val transport: SubmissionTransport? = null,
    val drafts: DraftAdapter? = null,
    val uploads: UploadAdapter? = null,
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

    suspend fun submit(): Map<String, Any?> {
        val found = validate()
        if (found.any { it["severity"] == "error" }) { status = "invalid"; statusMessage = "Please correct the errors below."; notifyListeners(); return mapOf("status" to "server-validation-failed", "issues" to found) }
        val t = transport ?: run { status = "failed"; statusMessage = "No submission transport configured."; notifyListeners(); return mapOf("status" to "config-error", "code" to "NO_TRANSPORT") }
        status = "submitting"; notifyListeners()
        val key = "compose-${System.currentTimeMillis()}-${rowSeq++}"
        return try {
            val result = t.submit(ir["formId"] as String, values, key)
            status = if (result["status"] == "succeeded") "succeeded" else "failed"
            statusMessage = if (result["status"] == "succeeded") "Submitted successfully." else (result["message"] as? String ?: result["status"] as String)
            @Suppress("UNCHECKED_CAST")
            if (result["status"] == "server-validation-failed") issues = result["issues"] as List<Map<String, Any?>>
            notifyListeners(); result
        } catch (e: Exception) {
            status = "failed"; statusMessage = e.toString(); notifyListeners(); mapOf("status" to "config-error", "message" to e.toString())
        }
    }

    suspend fun saveDraft() { drafts?.save(ir["formId"] as String, values) }
}
