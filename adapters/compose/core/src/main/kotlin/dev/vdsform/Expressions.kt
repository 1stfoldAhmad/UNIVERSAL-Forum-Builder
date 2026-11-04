package dev.vdsform

/**
 * vds.expr/1 expression engine — Kotlin port (Compose renderer).
 * Faithful port of the TS reference / verified Python, PHP and Dart ports.
 * Closed typed operator set, budgets, error-as-value. Verified against the
 * shared conformance fixtures (packages/form-conformance/fixtures/expressions.json).
 */

sealed class ExprResult {
    data class Ok(val value: Any?) : ExprResult()
    data class Err(val code: String, val message: String) : ExprResult()
}

object Expressions {
    val DEFAULT_LIMITS = mapOf("maxNodes" to 5000, "maxDepth" to 64, "maxCollectionItems" to 10000, "maxStringLength" to 1000000)
    private val FORBIDDEN = setOf("__proto__", "constructor", "prototype")
    private val REF_RE = Regex("^(field|context|item|parent|source):([A-Za-z_][A-Za-z0-9_.\\-*\\[\\]]*)$|^index$")
    private val DIGITS = Regex("^\\d+$")

    fun isNum(v: Any?): Boolean = v is Number && v.toDouble().isFinite()
    fun isStr(v: Any?): Boolean = v is String
    fun isBool(v: Any?): Boolean = v is Boolean

    /** Normalize whole doubles to Long so toString/JSON match the reference. */
    fun normNum(v: Any?): Any? = if (v is Double && v.isFinite() && v == Math.floor(v) && Math.abs(v) < 9.007199254740992E15) v.toLong() else v

    private fun ok(v: Any?): ExprResult = ExprResult.Ok(normNum(v))
    private fun err(code: String, msg: String): ExprResult = ExprResult.Err(code, msg)

    fun isSafePath(path: String): Boolean = path.split(".").all { !FORBIDDEN.contains(it.replace("[]", "")) }

    fun getPath(root: Any?, path: String): Any? {
        if (!isSafePath(path)) return null
        val segments = path.split(".")
        var current: List<Any?> = listOf(root)
        for (seg in segments) {
            val next = ArrayList<Any?>()
            for (node in current) {
                when {
                    node == null -> next.add(null)
                    seg == "*" -> if (node is List<*>) next.addAll(node) else next.add(null)
                    DIGITS.matches(seg) && node is List<*> -> { val i = seg.toInt(); next.add(if (i < node.size) node[i] else null) }
                    node is Map<*, *> -> next.add(node[seg])
                    else -> next.add(null)
                }
            }
            current = next
        }
        return if (segments.contains("*")) current else current.firstOrNull()
    }

    fun parseRef(ref: String): Pair<String, String>? {
        if (ref == "index") return "index" to ""
        val m = REF_RE.find(ref) ?: return null
        val kind = m.groupValues[1]
        val path = m.groupValues[2]
        if (kind.isEmpty()) return "index" to ""
        if (path.split(".").any { FORBIDDEN.contains(it) }) return null
        return kind to path
    }

    fun deepEqual(a: Any?, b: Any?): Boolean {
        if (a == null || b == null) return a == null && b == null
        if (a is Boolean || b is Boolean) return a is Boolean && b is Boolean && a == b
        if (isNum(a) && isNum(b)) return (a as Number).toDouble() == (b as Number).toDouble()
        if (isStr(a) && isStr(b)) return a == b
        if (a is List<*> && b is List<*>) { if (a.size != b.size) return false; return a.indices.all { deepEqual(a[it], b[it]) } }
        if (a is Map<*, *> && b is Map<*, *>) { if (a.size != b.size) return false; return a.keys.all { b.containsKey(it) && deepEqual(a[it], b[it]) } }
        return false
    }

    private fun str(v: Any?): String = when (v) {
        is Boolean -> if (v) "true" else "false"
        is String -> v
        is Number -> v.toString()
        else -> jsonEncode(v)
    }

    private fun jsonEncode(v: Any?): String {
        val sb = StringBuilder()
        fun enc(x: Any?) {
            when (x) {
                null -> sb.append("null")
                is Boolean -> sb.append(if (x) "true" else "false")
                is Number -> sb.append(x.toString())
                is String -> sb.append("\"").append(x.replace("\\", "\\\\").replace("\"", "\\\"")).append("\"")
                is List<*> -> { sb.append("["); x.forEachIndexed { i, e -> if (i > 0) sb.append(","); enc(e) }; sb.append("]") }
                is Map<*, *> -> { sb.append("{"); var first = true; for ((k, value) in x) { if (!first) sb.append(","); first = false; sb.append("\"").append(k).append("\":"); enc(value) }; sb.append("}") }
                else -> sb.append("\"").append(x.toString()).append("\"")
            }
        }
        enc(v); return sb.toString()
    }

    fun roundHalfAway(x: Double, digits: Int): Double {
        if (!x.isFinite()) return x
        val factor = Math.pow(10.0, digits.toDouble())
        val scaled = String.format("%.15g", Math.abs(x) * factor).replace(",", ".").toDouble()
        val rounded = Math.floor(scaled + 0.5)
        val sign = if (x < 0) -1 else 1
        return sign * rounded / factor
    }

    private fun isoDate(v: Any?): Long? {
        if (v !is String) return null
        if (!Regex("^\\d{4}-\\d{2}-\\d{2}(T.*)?$").matches(v)) return null
        val s = if (v.length == 10) "${v}T00:00:00Z" else v
        return try { java.time.Instant.parse(s.replace("Z", "+00:00")).toEpochMilli() } catch (e: Exception) {
            try { java.time.OffsetDateTime.parse(s).toInstant().toEpochMilli() } catch (e2: Exception) { null }
        }
    }

    private fun finite(v: Double): ExprResult = if (v.isFinite()) ok(v) else err("EXPR_OVERFLOW", "Numeric result is not finite.")

    private fun numbers(args: List<Any?>, skipNull: Boolean = false): ExprResult {
        val list = if (args.size == 1 && args[0] is List<*>) args[0] as List<*> else args
        val out = ArrayList<Double>()
        for (v in list) {
            if (v == null && skipNull) continue
            if (!isNum(v)) return err("EXPR_TYPE_ERROR", "Arithmetic expects finite numbers, got ${if (v == null) "null" else v!!::class.simpleName}.")
            out.add((v as Number).toDouble())
        }
        return ExprResult.Ok(out)
    }

    private fun reduce(args: List<Any?>, init: Double, skipNull: Boolean = false, fn: (Double, Double) -> Double): ExprResult {
        val n = numbers(args, skipNull)
        if (n !is ExprResult.Ok) return n
        var acc = init
        for (v in n.value as List<*>) acc = fn(acc, v as Double)
        return finite(acc)
    }

    private val ARITY = mapOf(
        "and" to (1 to -1), "or" to (1 to -1), "not" to (1 to 1), "if" to (3 to 3), "coalesce" to (1 to -1),
        "eq" to (2 to 2), "neq" to (2 to 2), "gt" to (2 to 2), "gte" to (2 to 2), "lt" to (2 to 2), "lte" to (2 to 2),
        "isNull" to (1 to 1), "isEmpty" to (1 to 1), "in" to (2 to 2), "contains" to (2 to 2),
        "concat" to (0 to -1), "len" to (1 to 1), "startsWith" to (2 to 2), "endsWith" to (2 to 2),
        "lower" to (1 to 1), "upper" to (1 to 1), "trim" to (1 to 1),
        "add" to (0 to -1), "mul" to (0 to -1), "sub" to (1 to -1), "div" to (2 to 2), "mod" to (2 to 2),
        "abs" to (1 to 1), "round" to (1 to 2), "sum" to (1 to -1), "avg" to (1 to -1), "min" to (1 to -1), "max" to (1 to -1), "count" to (1 to 1),
        "toNumber" to (1 to 1), "toString" to (1 to 1), "toBoolean" to (1 to 1), "dateAddDays" to (2 to 2), "dateDiffDays" to (2 to 2),
    )

    private fun apply(op: String, a: List<Any?>, limits: Map<String, Int>): ExprResult = when (op) {
        "and" -> if (a.all { isBool(it) }) ok(a.all { it == true }) else err("EXPR_TYPE_ERROR", "and expects booleans.")
        "or" -> if (a.all { isBool(it) }) ok(a.any { it == true }) else err("EXPR_TYPE_ERROR", "or expects booleans.")
        "not" -> if (isBool(a[0])) ok(!(a[0] as Boolean)) else err("EXPR_TYPE_ERROR", "not expects a boolean.")
        "if" -> if (isBool(a[0])) ok(if (a[0] == true) a[1] else a[2]) else err("EXPR_TYPE_ERROR", "if expects a boolean condition.")
        "coalesce" -> ok(a.firstOrNull { it != null })
        "eq" -> ok(deepEqual(a[0], a[1]))
        "neq" -> ok(!deepEqual(a[0], a[1]))
        "gt", "gte", "lt", "lte" -> {
            val x = a[0]; val y = a[1]
            fun cmp(p: Double, q: Double) = when (op) { "gt" -> p > q; "gte" -> p >= q; "lt" -> p < q; else -> p <= q }
            fun cmps(p: String, q: String) = when (op) { "gt" -> p > q; "gte" -> p >= q; "lt" -> p < q; else -> p <= q }
            if (isNum(x) && isNum(y)) ok(cmp((x as Number).toDouble(), (y as Number).toDouble()))
            else if (isStr(x) && isStr(y)) ok(cmps(x as String, y as String))
            else err("EXPR_TYPE_ERROR", "Comparison expects two numbers or two strings.")
        }
        "isNull" -> ok(a[0] == null)
        "isEmpty" -> when (val v = a[0]) {
            null -> ok(true); is String -> ok(v.isEmpty()); is List<*> -> ok(v.isEmpty()); is Map<*, *> -> ok(v.isEmpty()); else -> ok(false)
        }
        "in" -> if (a[1] is List<*>) ok((a[1] as List<*>).any { deepEqual(it, a[0]) }) else err("EXPR_TYPE_ERROR", "in expects (value, array).")
        "contains" -> when (val c = a[0]) {
            is String -> if (isStr(a[1])) ok(c.contains(a[1] as String)) else err("EXPR_TYPE_ERROR", "contains expects (string, string) or (array, value).")
            is List<*> -> ok(c.any { deepEqual(it, a[1]) })
            else -> err("EXPR_TYPE_ERROR", "contains expects (string, string) or (array, value).")
        }
        "concat" -> {
            var out = ""
            for (v in a) {
                if (v == null) continue
                if (!(isStr(v) || isNum(v) || isBool(v))) return err("EXPR_TYPE_ERROR", "concat expects strings/numbers/booleans.")
                out += str(v)
                if (out.length > limits["maxStringLength"]!!) return err("EXPR_LIMIT_EXCEEDED", "concat exceeded string budget.")
            }
            ok(out)
        }
        "len" -> when (val v = a[0]) {
            is String -> ok(v.length); is List<*> -> if (v.size > limits["maxCollectionItems"]!!) err("EXPR_LIMIT_EXCEEDED", "Collection too large.") else ok(v.size)
            null -> ok(0); else -> err("EXPR_TYPE_ERROR", "len expects string or array.")
        }
        "startsWith" -> if (isStr(a[0]) && isStr(a[1])) ok((a[0] as String).startsWith(a[1] as String)) else err("EXPR_TYPE_ERROR", "startsWith expects strings.")
        "endsWith" -> if (isStr(a[0]) && isStr(a[1])) ok((a[0] as String).endsWith(a[1] as String)) else err("EXPR_TYPE_ERROR", "endsWith expects strings.")
        "lower" -> if (isStr(a[0])) ok((a[0] as String).lowercase()) else err("EXPR_TYPE_ERROR", "lower expects a string.")
        "upper" -> if (isStr(a[0])) ok((a[0] as String).uppercase()) else err("EXPR_TYPE_ERROR", "upper expects a string.")
        "trim" -> if (isStr(a[0])) ok((a[0] as String).trim()) else err("EXPR_TYPE_ERROR", "trim expects a string.")
        "add" -> reduce(a, 0.0) { x, y -> x + y }
        "mul" -> reduce(a, 1.0) { x, y -> x * y }
        "sub" -> {
            val n = numbers(a); if (n !is ExprResult.Ok) return n
            val vals = n.value as List<*>; if (vals.isEmpty()) return ok(0)
            var acc = vals[0] as Double; for (v in vals.drop(1)) acc -= v as Double; finite(acc)
        }
        "div" -> if (!isNum(a[0]) || !isNum(a[1])) err("EXPR_TYPE_ERROR", "div expects numbers.")
            else if ((a[1] as Number).toDouble() == 0.0) err("EXPR_DIVISION_BY_ZERO", "Division by zero.")
            else finite((a[0] as Number).toDouble() / (a[1] as Number).toDouble())
        "mod" -> if (!isNum(a[0]) || !isNum(a[1])) err("EXPR_TYPE_ERROR", "mod expects numbers.")
            else if ((a[1] as Number).toDouble() == 0.0) err("EXPR_DIVISION_BY_ZERO", "Modulo by zero.")
            else { val x = (a[0] as Number).toDouble(); val y = (a[1] as Number).toDouble(); finite(x % y) }
        "abs" -> if (isNum(a[0])) ok(Math.abs((a[0] as Number).toDouble())) else err("EXPR_TYPE_ERROR", "abs expects a number.")
        "round" -> {
            if (!isNum(a[0])) return err("EXPR_TYPE_ERROR", "round expects a number.")
            val d = if (a.size > 1) a[1] else 0
            if (!isNum(d) || (d as Number).toDouble() != Math.floor(d.toDouble()) || d.toDouble() < 0 || d.toDouble() > 10) err("EXPR_TYPE_ERROR", "round digits must be integer 0..10.")
            else ok(roundHalfAway((a[0] as Number).toDouble(), d.toInt()))
        }
        "sum" -> reduce(a, 0.0, skipNull = true) { x, y -> x + y }
        "avg" -> { val n = numbers(a, true); if (n !is ExprResult.Ok) return n; val vals = n.value as List<*>; if (vals.isEmpty()) ok(null) else finite(vals.sumOf { it as Double } / vals.size) }
        "min", "max" -> { val n = numbers(a, true); if (n !is ExprResult.Ok) return n; val vals = (n.value as List<*>).map { it as Double }; if (vals.isEmpty()) ok(null) else ok(if (op == "min") vals.min() else vals.max()) }
        "count" -> when (val v = a[0]) { is List<*> -> ok(v.size); null -> ok(0); else -> err("EXPR_TYPE_ERROR", "count expects an array.") }
        "toNumber" -> when (val v = a[0]) {
            null -> ok(null); is Number -> ok(v); is Boolean -> ok(if (v) 1 else 0)
            is String -> { val t = v.trim(); val f = t.toDoubleOrNull(); if (t.isNotEmpty() && f != null && f.isFinite()) ok(if (f == Math.floor(f) && !t.contains(".") && !t.lowercase().contains("e")) f.toLong() else f) else err("EXPR_TYPE_ERROR", "toNumber cannot convert value.") }
            else -> err("EXPR_TYPE_ERROR", "toNumber cannot convert value.")
        }
        "toString" -> ok(if (a[0] == null) "" else str(a[0]))
        "toBoolean" -> when (val v = a[0]) {
            is Boolean -> ok(v); null -> ok(false); is Number -> ok(v.toDouble() != 0.0); is String -> ok(v.isNotEmpty()); is List<*> -> ok(v.isNotEmpty()); else -> ok(true)
        }
        "dateAddDays" -> {
            val t = isoDate(a[0])
            if (t == null || !isNum(a[1]) || (a[1] as Number).toDouble() != Math.floor(a[1].toDouble())) err("EXPR_TYPE_ERROR", "dateAddDays expects (ISO date, integer days).")
            else { val d = java.time.Instant.ofEpochMilli(t + (a[1] as Number).toLong() * 86400000L).atZone(java.time.ZoneOffset.UTC).toLocalDate(); ok(String.format("%04d-%02d-%02d", d.year, d.monthValue, d.dayOfMonth)) }
        }
        "dateDiffDays" -> { val x = isoDate(a[0]); val y = isoDate(a[1]); if (x == null || y == null) err("EXPR_TYPE_ERROR", "dateDiffDays expects ISO dates.") else ok(Math.round((x - y) / 86400000.0)) }
        else -> err("EXPR_UNKNOWN_OPERATOR", "Unknown operator \"$op\".")
    }

    private fun resolveRef(ref: String, scope: Map<String, Any?>, limits: Map<String, Int>): ExprResult {
        val parsed = parseRef(ref) ?: return err("EXPR_REFERENCE_INVALID", "Invalid reference \"$ref\".")
        val (kind, path) = parsed
        return when (kind) {
            "field" -> { val v = getPath(scope["values"], path); if (v is List<*> && path.contains("*") && v.size > limits["maxCollectionItems"]!!) err("EXPR_LIMIT_EXCEEDED", "Wildcard projection exceeded collection budget.") else ok(v) }
            "item" -> if (scope["rowPrefix"] == null) err("EXPR_SCOPE_ERROR", "item: reference \"$ref\" used outside a repeater row.") else ok(getPath(scope["values"], "${scope["rowPrefix"]}.$path"))
            "parent" -> { val full = if (scope["parentPrefix"] != null) "${scope["parentPrefix"]}.$path" else path; ok(getPath(scope["values"], full)) }
            "index" -> if (scope["rowIndex"] == null) err("EXPR_SCOPE_ERROR", "index reference used outside a repeater row.") else ok(scope["rowIndex"])
            "context" -> ok(getPath(scope["context"] ?: emptyMap<String, Any?>(), path))
            "source" -> ok((scope["sources"] as? Map<*, *>)?.get(path))
            else -> err("EXPR_REFERENCE_INVALID", "Invalid reference \"$ref\".")
        }
    }

    fun measureExpr(expr: Map<String, Any?>): Pair<Int, Int> {
        var nodes = 0; var maxDepth = 0
        fun walk(e: Map<String, Any?>, d: Int) { nodes++; if (d > maxDepth) maxDepth = d; if (e.containsKey("op")) for (a in (e["args"] as? List<*> ?: emptyList<Any?>())) walk(a as Map<String, Any?>, d + 1) }
        walk(expr, 1); return nodes to maxDepth
    }

    fun evaluate(expr: Map<String, Any?>, scope: Map<String, Any?>): ExprResult {
        val limits = DEFAULT_LIMITS + ((scope["limits"] as? Map<String, Int>) ?: emptyMap())
        val (nodes, depth) = measureExpr(expr)
        if (nodes > limits["maxNodes"]!!) return err("EXPR_LIMIT_EXCEEDED", "Expression has $nodes nodes (max ${limits["maxNodes"]}).")
        if (depth > limits["maxDepth"]!!) return err("EXPR_LIMIT_EXCEEDED", "Expression depth $depth exceeds max ${limits["maxDepth"]}.")
        var budget = limits["maxNodes"]!! * 4

        fun evalNode(e: Map<String, Any?>, d: Int): ExprResult {
            budget--
            if (budget < 0) return err("EXPR_LIMIT_EXCEEDED", "Evaluation budget exhausted.")
            if (d > limits["maxDepth"]!!) return err("EXPR_LIMIT_EXCEEDED", "Depth budget exceeded.")
            if (e.containsKey("const")) return ok(e["const"])
            if (e.containsKey("ref")) return resolveRef(e["ref"] as String, scope, limits)
            if (!e.containsKey("op")) return err("EXPR_REFERENCE_INVALID", "Malformed expression node.")
            val op = e["op"] as String
            val argsAst = (e["args"] as? List<*> ?: emptyList<Any?>()).map { it as Map<String, Any?> }
            val arity = ARITY[op] ?: return err("EXPR_UNKNOWN_OPERATOR", "Unknown operator \"$op\".")
            if (argsAst.size < arity.first || (arity.second != -1 && argsAst.size > arity.second)) return err("EXPR_TYPE_ERROR", "Operator \"$op\" has wrong arity (${argsAst.size}).")
            if (op == "and" || op == "or") {
                for (a in argsAst) { val r = evalNode(a, d + 1); if (r !is ExprResult.Ok) return r; if (!isBool(r.value)) return err("EXPR_TYPE_ERROR", "$op expects booleans."); if (op == "and" && r.value == false) return ok(false); if (op == "or" && r.value == true) return ok(true) }
                return ok(op == "and")
            }
            if (op == "if") { val c = evalNode(argsAst[0], d + 1); if (c !is ExprResult.Ok) return c; if (!isBool(c.value)) return err("EXPR_TYPE_ERROR", "if expects a boolean condition."); return evalNode(if (c.value == true) argsAst[1] else argsAst[2], d + 1) }
            if (op == "coalesce") { for (a in argsAst) { val r = evalNode(a, d + 1); if (r !is ExprResult.Ok) return r; if (r.value != null) return ok(r.value) }; return ok(null) }
            val args = ArrayList<Any?>()
            for (a in argsAst) { val r = evalNode(a, d + 1); if (r !is ExprResult.Ok) return r; args.add(r.value) }
            return apply(op, args, limits)
        }
        return evalNode(expr, 1)
    }

    fun evaluateBoolean(expr: Map<String, Any?>, scope: Map<String, Any?>): ExprResult {
        val r = evaluate(expr, scope)
        if (r !is ExprResult.Ok) return r
        if (!isBool(r.value)) return err("EXPR_TYPE_ERROR", "Condition must evaluate to a boolean.")
        return r
    }
}
