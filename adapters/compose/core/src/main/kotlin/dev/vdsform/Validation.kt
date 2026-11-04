package dev.vdsform

/**
 * Effective state + validation — Kotlin port. Operates on the compiled FormIR
 * (shared cross-language contract). Mirrors packages/form-validation.
 */

data class EffectiveState(
    val visibility: MutableMap<String, Boolean> = mutableMapOf(),
    val required: MutableMap<String, Boolean> = mutableMapOf(),
    val disabled: MutableMap<String, Boolean> = mutableMapOf(),
    val readonly: MutableMap<String, Boolean> = mutableMapOf(),
)

data class FieldInstance(val field: Map<String, Any?>, val concreteKey: String)

object Validation {
    private val FORMAT_PATTERNS = mapOf(
        "email" to Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$"),
        "url" to Regex("^https?://[^\\s/$.?#].[^\\s]*$", RegexOption.IGNORE_CASE),
        "phone" to Regex("^\\+?[0-9\\s\\-().]{6,20}$"),
        "date" to Regex("^\\d{4}-\\d{2}-\\d{2}$"),
        "time" to Regex("^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$"),
        "uuid" to Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE),
        "color" to Regex("#([0-9a-f]{3}|[0-9a-f]{6})$", RegexOption.IGNORE_CASE),
    )

    fun localize(text: Any?, locale: String, fallback: String = "en"): String = when (text) {
        null -> ""
        is String -> text
        is Map<*, *> -> (text[locale] ?: text[fallback] ?: text.values.firstOrNull() ?: "").toString()
        else -> text.toString()
    }

    @Suppress("UNCHECKED_CAST")
    fun setIn(root: Map<String, Any?>, path: String, value: Any?): Map<String, Any?> {
        val segments = path.split(".")
        fun recur(node: Any?, i: Int): Any? {
            if (i == segments.size) return value
            val seg = segments[i]
            if (Regex("^\\d+$").matches(seg)) {
                val arr = if (node is List<*>) ArrayList<Any?>(node) else ArrayList()
                val idx = seg.toInt()
                while (arr.size <= idx) arr.add(null)
                arr[idx] = recur(arr[idx], i + 1)
                return arr
            }
            val obj = if (node is Map<*, *>) LinkedHashMap<String, Any?>(node as Map<String, Any?>) else LinkedHashMap()
            obj[seg] = recur(obj[seg], i + 1)
            return obj
        }
        return recur(root, 0) as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    fun computeEffectiveState(ir: Map<String, Any?>, values: Map<String, Any?>, context: Map<String, Any?> = emptyMap(), sources: Map<String, Any?> = emptyMap()): EffectiveState {
        val state = EffectiveState()
        for (f in ir["fields"] as List<Map<String, Any?>>) {
            val id = f["id"] as String
            state.visibility[id] = f["hidden"] != true
            state.required[id] = f["required"] == true
            state.disabled[id] = f["disabled"] == true
            state.readonly[id] = f["readonly"] == true
        }
        for (c in (ir["conditions"] as? List<Map<String, Any?>> ?: emptyList())) {
            val r = Expressions.evaluateBoolean(c["when"] as Map<String, Any?>, mapOf("values" to values, "context" to context, "sources" to sources))
            if (r !is ExprResult.Ok || r.value != true) continue
            for (eff in (c["effects"] as? List<Map<String, Any?>> ?: emptyList())) {
                val s = (eff["set"] as? Map<*, *>) ?: emptyMap<String, Any?>()
                val fid = eff["fieldId"] as String
                if (s.containsKey("visible")) state.visibility[fid] = s["visible"] == true
                if (s.containsKey("required")) state.required[fid] = s["required"] == true
                if (s.containsKey("disabled")) state.disabled[fid] = s["disabled"] == true
                if (s.containsKey("readonly")) state.readonly[fid] = s["readonly"] == true
            }
        }
        return state
    }

    @Suppress("UNCHECKED_CAST")
    fun expandFieldInstances(ir: Map<String, Any?>, values: Map<String, Any?>): List<FieldInstance> {
        val out = ArrayList<FieldInstance>()
        val repeaters = HashMap<String, Map<String, Any?>>()
        for (f in ir["fields"] as List<Map<String, Any?>>) if (f["type"] == "repeater") repeaters[f["id"] as String] = f
        for (f in ir["fields"] as List<Map<String, Any?>>) {
            if (f["type"] == "repeater" || f["type"] == "group") out.add(FieldInstance(f, f["key"] as String))
            val repId = f["repeaterId"] as? String
            if (repId == null) { if (f["type"] != "repeater" && f["type"] != "group") out.add(FieldInstance(f, f["key"] as String)); continue }
            val rep = repeaters[repId] ?: continue
            val rows = Expressions.getPath(values, rep["key"] as String)
            val n = if (rows is List<*>) rows.size else 0
            for (i in 0 until n) out.add(FieldInstance(f, (f["key"] as String).replace("[]", ".$i")))
        }
        return out
    }

    fun isEmptyValue(v: Any?): Boolean = when (v) {
        null -> true; is String -> v.isEmpty(); is List<*> -> v.isEmpty(); is Map<*, *> -> v.isEmpty(); else -> false
    }

    private fun issue(code: String, message: String, path: String, fieldId: String? = null): Map<String, Any?> =
        buildMap { put("code", code); put("message", message); put("path", path); put("severity", "error"); put("source", "field"); if (fieldId != null) put("fieldId", fieldId) }

    @Suppress("UNCHECKED_CAST")
    fun validateValues(ir: Map<String, Any?>, values: Map<String, Any?>, state: EffectiveState, phase: String = "submit", locale: String = "en"): List<Map<String, Any?>> {
        val issues = ArrayList<Map<String, Any?>>()
        for (inst in expandFieldInstances(ir, values)) {
            val f = inst.field; val id = f["id"] as String
            if (state.visibility[id] == false) continue
            val v = Expressions.getPath(values, inst.concreteKey)
            val required = state.required[id] == true
            val label = localize(f["label"], locale)
            if (required && isEmptyValue(v)) { issues.add(issue("REQUIRED", "$label is required.", inst.concreteKey, id)); continue }
            if (isEmptyValue(v)) continue
            val val_ = (f["validation"] as? Map<*, *>) ?: emptyMap<String, Any?>()
            val vt = f["valueType"] as? String ?: "string"
            if (vt == "integer" && v !is Long && v !is Int) issues.add(issue("TYPE", "$label must be an integer.", inst.concreteKey, id))
            if (vt == "number" && v !is Number) issues.add(issue("TYPE", "$label must be a number.", inst.concreteKey, id))
            if (v is Number) {
                val d = v.toDouble()
                (val_["min"] as? Number)?.let { if (d < it.toDouble()) issues.add(issue("MIN", "$label must be ≥ $it.", inst.concreteKey, id)) }
                (val_["max"] as? Number)?.let { if (d > it.toDouble()) issues.add(issue("MAX", "$label must be ≤ $it.", inst.concreteKey, id)) }
            }
            if (v is String) {
                (val_["minLength"] as? Number)?.let { if (v.length < it.toInt()) issues.add(issue("MIN_LENGTH", "$label is too short.", inst.concreteKey, id)) }
                (val_["maxLength"] as? Number)?.let { if (v.length > it.toInt()) issues.add(issue("MAX_LENGTH", "$label is too long.", inst.concreteKey, id)) }
                (val_["pattern"] as? String)?.let { if (it.length <= 1000 && !Regex(it).containsMatchIn(v)) issues.add(issue("PATTERN", "$label has an invalid format.", inst.concreteKey, id)) }
                (val_["format"] as? String)?.let { fmt -> FORMAT_PATTERNS[fmt]?.let { p -> if (!p.containsMatchIn(v)) issues.add(issue("FORMAT", "$label has an invalid format.", inst.concreteKey, id)) } }
            }
            if (v is List<*>) {
                (val_["minItems"] as? Number)?.let { if (v.size < it.toInt()) issues.add(issue("MIN_ITEMS", "$label needs more entries.", inst.concreteKey, id)) }
                (val_["maxItems"] as? Number)?.let { if (v.size > it.toInt()) issues.add(issue("MAX_ITEMS", "$label has too many entries.", inst.concreteKey, id)) }
            }
        }
        for (rule in (ir["crossFieldRules"] as? List<Map<String, Any?>> ?: emptyList())) {
            val r = Expressions.evaluateBoolean(rule["expr"] as Map<String, Any?>, mapOf("values" to values))
            if (r is ExprResult.Ok && r.value == false) issues.add(issue("CROSS_FIELD", localize(rule["message"], locale), (rule["path"] as? String) ?: ""))
        }
        return issues
    }
}
