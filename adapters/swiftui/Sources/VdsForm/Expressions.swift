import Foundation

/// vds.expr/1 expression engine — Swift port (SwiftUI renderer).
/// Faithful port of the TS reference / verified Python, PHP, Dart and Kotlin
/// ports. Closed typed operator set, budgets, error-as-value. Verified against
/// the shared conformance fixtures (expressions.json).

public enum ExprResult {
    case ok(Any?)
    case err(String, String)

    public var isOk: Bool { if case .ok = self { return true }; return false }
    public var value: Any? { if case .ok(let v) = self { return v }; return nil }
    public var code: String? { if case .err(let c, _) = self { return c }; return nil }
}

public enum Expressions {
    public static let defaultLimits: [String: Int] = ["maxNodes": 5000, "maxDepth": 64, "maxCollectionItems": 10000, "maxStringLength": 1000000]
    static let forbidden: Set<String> = ["__proto__", "constructor", "prototype"]
    static let refRe = try! NSRegularExpression(pattern: "^(field|context|item|parent|source):([A-Za-z_][A-Za-z0-9_.\\-*\\[\\]]*)$|^index$")
    static let digits = try! NSRegularExpression(pattern: "^\\d+$")

    public static func isBool(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }
    public static func isNum(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber, !isBool(n) else { return false }
        return n.doubleValue.isFinite
    }
    public static func isStr(_ v: Any?) -> Bool { v is String }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    public static func isSafePath(_ path: String) -> Bool {
        path.split(separator: ".").allSatisfy { !forbidden.contains($0.replacingOccurrences(of: "[]", with: "")) }
    }

    public static func getPath(_ root: Any?, _ path: String) -> Any? {
        if !isSafePath(path) { return nil }
        let segments = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        var current: [Any?] = [root]
        for seg in segments {
            var next: [Any?] = []
            for node in current {
                guard let node = node else { next.append(nil); continue }
                if seg == "*" {
                    if let arr = node as? [Any] { next.append(contentsOf: arr.map { $0 as Any? }) } else { next.append(nil) }
                } else if matches(digits, seg), let arr = node as? [Any] {
                    let i = Int(seg)!; next.append(i < arr.count ? arr[i] : nil)
                } else if let obj = node as? [String: Any] {
                    next.append(obj[seg])
                } else { next.append(nil) }
            }
            current = next
        }
        return segments.contains("*") ? current : current.first ?? nil
    }

    public static func parseRef(_ ref: String) -> (String, String)? {
        if ref == "index" { return ("index", "") }
        guard let m = refRe.firstMatch(in: ref, range: NSRange(ref.startIndex..., in: ref)) else { return nil }
        let kind = m.range(at: 1).location == NSNotFound ? "" : (ref as NSString).substring(with: m.range(at: 1))
        let path = m.range(at: 2).location == NSNotFound ? "" : (ref as NSString).substring(with: m.range(at: 2))
        if kind.isEmpty { return ("index", "") }
        if path.split(separator: ".").contains(where: { forbidden.contains(String($0)) }) { return nil }
        return (kind, path)
    }

    public static func deepEqual(_ a: Any?, _ b: Any?) -> Bool {
        if a == nil || b == nil { return a == nil && b == nil }
        if isBool(a) || isBool(b) { return isBool(a) && isBool(b) && (a as! NSNumber).boolValue == (b as! NSNumber).boolValue }
        if isNum(a) && isNum(b) { return (a as! NSNumber).doubleValue == (b as! NSNumber).doubleValue }
        if isStr(a) && isStr(b) { return (a as! String) == (b as! String) }
        if let x = a as? [Any], let y = b as? [Any] {
            if x.count != y.count { return false }
            return zip(x, y).allSatisfy { deepEqual($0, $1) }
        }
        if let x = a as? [String: Any], let y = b as? [String: Any] {
            if x.count != y.count { return false }
            return x.keys.allSatisfy { y[$0] != nil && deepEqual(x[$0], y[$0]) }
        }
        return false
    }

    static func str(_ v: Any?) -> String {
        if isBool(v) { return (v as! NSNumber).boolValue ? "true" : "false" }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        if let data = try? JSONSerialization.data(withJSONObject: v as Any, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) { return s }
        return "\(v ?? "")"
    }

    public static func roundHalfAway(_ x: Double, _ digits: Int) -> Double {
        if !x.isFinite { return x }
        let factor = pow(10.0, Double(digits))
        let scaled = Double(String(format: "%.15g", abs(x) * factor)) ?? (abs(x) * factor)
        let rounded = (scaled + 0.5).rounded(.down)
        let sign = x < 0 ? -1.0 : 1.0
        return sign * rounded / factor
    }

    static func isoDate(_ v: Any?) -> Int64? {
        guard let s = v as? String else { return nil }
        guard matches(try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}(T.*)?$"), s) else { return nil }
        let full = s.count == 10 ? s + "T00:00:00Z" : s
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: full) { return Int64(d.timeIntervalSince1970 * 1000) }
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: full) { return Int64(d.timeIntervalSince1970 * 1000) }
        return nil
    }

    static func finite(_ v: Double) -> ExprResult { v.isFinite ? .ok(NSNumber(value: v)) : .err("EXPR_OVERFLOW", "Numeric result is not finite.") }

    static func numbers(_ args: [Any?], skipNull: Bool = false) -> ExprResult {
        let list: [Any?] = (args.count == 1 && args[0] is [Any]) ? (args[0] as! [Any]).map { $0 as Any? } : args
        var out: [Double] = []
        for v in list {
            if v == nil && skipNull { continue }
            guard isNum(v) else { return .err("EXPR_TYPE_ERROR", "Arithmetic expects finite numbers, got \(v == nil ? "null" : "\(type(of: v!))").") }
            out.append((v as! NSNumber).doubleValue)
        }
        return .ok(out)
    }

    static func reduce(_ args: [Any?], _ init_: Double, skipNull: Bool = false, _ fn: (Double, Double) -> Double) -> ExprResult {
        let n = numbers(args, skipNull: skipNull)
        guard case .ok(let vals) = n, let arr = vals as? [Double] else { return n }
        var acc = init_; for v in arr { acc = fn(acc, v) }
        return finite(acc)
    }

    static let arity: [String: (Int, Int)] = [
        "and": (1, -1), "or": (1, -1), "not": (1, 1), "if": (3, 3), "coalesce": (1, -1),
        "eq": (2, 2), "neq": (2, 2), "gt": (2, 2), "gte": (2, 2), "lt": (2, 2), "lte": (2, 2),
        "isNull": (1, 1), "isEmpty": (1, 1), "in": (2, 2), "contains": (2, 2),
        "concat": (0, -1), "len": (1, 1), "startsWith": (2, 2), "endsWith": (2, 2),
        "lower": (1, 1), "upper": (1, 1), "trim": (1, 1),
        "add": (0, -1), "mul": (0, -1), "sub": (1, -1), "div": (2, 2), "mod": (2, 2),
        "abs": (1, 1), "round": (1, 2), "sum": (1, -1), "avg": (1, -1), "min": (1, -1), "max": (1, -1), "count": (1, 1),
        "toNumber": (1, 1), "toString": (1, 1), "toBoolean": (1, 1), "dateAddDays": (2, 2), "dateDiffDays": (2, 2),
    ]

    static func apply(_ op: String, _ a: [Any?], _ limits: [String: Int]) -> ExprResult {
        switch op {
        case "and": return a.allSatisfy { isBool($0) } ? .ok(NSNumber(value: a.allSatisfy { ($0 as? NSNumber)?.boolValue == true })) : .err("EXPR_TYPE_ERROR", "and expects booleans.")
        case "or": return a.allSatisfy { isBool($0) } ? .ok(NSNumber(value: a.contains { ($0 as? NSNumber)?.boolValue == true })) : .err("EXPR_TYPE_ERROR", "or expects booleans.")
        case "not": return isBool(a[0]) ? .ok(NSNumber(value: !((a[0] as! NSNumber).boolValue))) : .err("EXPR_TYPE_ERROR", "not expects a boolean.")
        case "if": return isBool(a[0]) ? .ok((a[0] as! NSNumber).boolValue ? a[1] : a[2]) : .err("EXPR_TYPE_ERROR", "if expects a boolean condition.")
        case "coalesce": return .ok(a.first { $0 != nil } ?? nil)
        case "eq": return .ok(NSNumber(value: deepEqual(a[0], a[1])))
        case "neq": return .ok(NSNumber(value: !deepEqual(a[0], a[1])))
        case "gt", "gte", "lt", "lte":
            func cmp(_ p: Double, _ q: Double) -> Bool { op == "gt" ? p > q : op == "gte" ? p >= q : op == "lt" ? p < q : p <= q }
            func cmps(_ p: String, _ q: String) -> Bool { op == "gt" ? p > q : op == "gte" ? p >= q : op == "lt" ? p < q : p <= q }
            if isNum(a[0]) && isNum(a[1]) { return .ok(NSNumber(value: cmp((a[0] as! NSNumber).doubleValue, (a[1] as! NSNumber).doubleValue))) }
            if isStr(a[0]) && isStr(a[1]) { return .ok(NSNumber(value: cmps(a[0] as! String, a[1] as! String))) }
            return .err("EXPR_TYPE_ERROR", "Comparison expects two numbers or two strings.")
        case "isNull": return .ok(NSNumber(value: a[0] == nil))
        case "isEmpty":
            if a[0] == nil { return .ok(NSNumber(value: true)) }
            if let s = a[0] as? String { return .ok(NSNumber(value: s.isEmpty)) }
            if let arr = a[0] as? [Any] { return .ok(NSNumber(value: arr.isEmpty)) }
            if let o = a[0] as? [String: Any] { return .ok(NSNumber(value: o.isEmpty)) }
            return .ok(NSNumber(value: false))
        case "in":
            guard let arr = a[1] as? [Any] else { return .err("EXPR_TYPE_ERROR", "in expects (value, array).") }
            return .ok(NSNumber(value: arr.contains { deepEqual($0, a[0]) }))
        case "contains":
            if let s = a[0] as? String, let x = a[1] as? String { return .ok(NSNumber(value: s.contains(x))) }
            if let arr = a[0] as? [Any] { return .ok(NSNumber(value: arr.contains { deepEqual($0, a[1]) })) }
            return .err("EXPR_TYPE_ERROR", "contains expects (string, string) or (array, value).")
        case "concat":
            var out = ""
            for v in a {
                if v == nil { continue }
                if !(isStr(v) || isNum(v) || isBool(v)) { return .err("EXPR_TYPE_ERROR", "concat expects strings/numbers/booleans.") }
                out += str(v)
                if out.count > limits["maxStringLength"]! { return .err("EXPR_LIMIT_EXCEEDED", "concat exceeded string budget.") }
            }
            return .ok(out)
        case "len":
            if let s = a[0] as? String { return .ok(NSNumber(value: s.count)) }
            if let arr = a[0] as? [Any] { return arr.count > limits["maxCollectionItems"]! ? .err("EXPR_LIMIT_EXCEEDED", "Collection too large.") : .ok(NSNumber(value: arr.count)) }
            if a[0] == nil { return .ok(NSNumber(value: 0)) }
            return .err("EXPR_TYPE_ERROR", "len expects string or array.")
        case "startsWith": return isStr(a[0]) && isStr(a[1]) ? .ok(NSNumber(value: (a[0] as! String).hasPrefix(a[1] as! String))) : .err("EXPR_TYPE_ERROR", "startsWith expects strings.")
        case "endsWith": return isStr(a[0]) && isStr(a[1]) ? .ok(NSNumber(value: (a[0] as! String).hasSuffix(a[1] as! String))) : .err("EXPR_TYPE_ERROR", "endsWith expects strings.")
        case "lower": return isStr(a[0]) ? .ok((a[0] as! String).lowercased()) : .err("EXPR_TYPE_ERROR", "lower expects a string.")
        case "upper": return isStr(a[0]) ? .ok((a[0] as! String).uppercased()) : .err("EXPR_TYPE_ERROR", "upper expects a string.")
        case "trim": return isStr(a[0]) ? .ok((a[0] as! String).trimmingCharacters(in: .whitespacesAndNewlines)) : .err("EXPR_TYPE_ERROR", "trim expects a string.")
        case "add": return reduce(a, 0) { $0 + $1 }
        case "mul": return reduce(a, 1) { $0 * $1 }
        case "sub":
            guard case .ok(let vals) = numbers(a), let arr = vals as? [Double] else { return numbers(a) }
            if arr.isEmpty { return .ok(NSNumber(value: 0)) }
            var acc = arr[0]; for v in arr.dropFirst() { acc -= v }; return finite(acc)
        case "div":
            if !isNum(a[0]) || !isNum(a[1]) { return .err("EXPR_TYPE_ERROR", "div expects numbers.") }
            if (a[1] as! NSNumber).doubleValue == 0 { return .err("EXPR_DIVISION_BY_ZERO", "Division by zero.") }
            return finite((a[0] as! NSNumber).doubleValue / (a[1] as! NSNumber).doubleValue)
        case "mod":
            if !isNum(a[0]) || !isNum(a[1]) { return .err("EXPR_TYPE_ERROR", "mod expects numbers.") }
            if (a[1] as! NSNumber).doubleValue == 0 { return .err("EXPR_DIVISION_BY_ZERO", "Modulo by zero.") }
            return finite(fmod((a[0] as! NSNumber).doubleValue, (a[1] as! NSNumber).doubleValue))
        case "abs": return isNum(a[0]) ? .ok(NSNumber(value: abs((a[0] as! NSNumber).doubleValue))) : .err("EXPR_TYPE_ERROR", "abs expects a number.")
        case "round":
            if !isNum(a[0]) { return .err("EXPR_TYPE_ERROR", "round expects a number.") }
            let d: Any? = a.count > 1 ? a[1] : NSNumber(value: 0)
            if !isNum(d) { return .err("EXPR_TYPE_ERROR", "round digits must be integer 0..10.") }
            let dv = (d as! NSNumber).doubleValue
            if dv != dv.rounded() || dv < 0 || dv > 10 { return .err("EXPR_TYPE_ERROR", "round digits must be integer 0..10.") }
            return .ok(NSNumber(value: roundHalfAway((a[0] as! NSNumber).doubleValue, Int(dv))))
        case "sum": return reduce(a, 0, skipNull: true) { $0 + $1 }
        case "avg":
            guard case .ok(let vals) = numbers(a, skipNull: true), let arr = vals as? [Double] else { return numbers(a, skipNull: true) }
            if arr.isEmpty { return .ok(nil) }
            return finite(arr.reduce(0, +) / Double(arr.count))
        case "min", "max":
            guard case .ok(let vals) = numbers(a, skipNull: true), let arr = vals as? [Double] else { return numbers(a, skipNull: true) }
            if arr.isEmpty { return .ok(nil) }
            return .ok(NSNumber(value: op == "min" ? arr.min()! : arr.max()!))
        case "count":
            if let arr = a[0] as? [Any] { return .ok(NSNumber(value: arr.count)) }
            if a[0] == nil { return .ok(NSNumber(value: 0)) }
            return .err("EXPR_TYPE_ERROR", "count expects an array.")
        case "toNumber":
            if a[0] == nil { return .ok(nil) }
            if isNum(a[0]) { return .ok(a[0]) }
            if isBool(a[0]) { return .ok(NSNumber(value: (a[0] as! NSNumber).boolValue ? 1 : 0)) }
            if let s = a[0] as? String, !s.trimmingCharacters(in: .whitespaces).isEmpty, let f = Double(s), f.isFinite {
                if f == f.rounded() && !s.contains(".") && !s.lowercased().contains("e") { return .ok(NSNumber(value: Int(f))) }
                return .ok(NSNumber(value: f))
            }
            return .err("EXPR_TYPE_ERROR", "toNumber cannot convert value.")
        case "toString": return .ok(a[0] == nil ? "" : str(a[0]))
        case "toBoolean":
            if isBool(a[0]) { return .ok(a[0]) }
            if a[0] == nil { return .ok(NSNumber(value: false)) }
            if isNum(a[0]) { return .ok(NSNumber(value: (a[0] as! NSNumber).doubleValue != 0)) }
            if let s = a[0] as? String { return .ok(NSNumber(value: !s.isEmpty)) }
            if let arr = a[0] as? [Any] { return .ok(NSNumber(value: !arr.isEmpty)) }
            return .ok(NSNumber(value: true))
        case "dateAddDays":
            guard let t = isoDate(a[0]), isNum(a[1]) else { return .err("EXPR_TYPE_ERROR", "dateAddDays expects (ISO date, integer days).") }
            let dv = (a[1] as! NSNumber).doubleValue
            if dv != dv.rounded() { return .err("EXPR_TYPE_ERROR", "dateAddDays expects (ISO date, integer days).") }
            let date = Date(timeIntervalSince1970: Double(t + Int64(dv) * 86400000) / 1000)
            var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
            let c = cal.dateComponents([.year, .month, .day], from: date)
            return .ok(String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!))
        case "dateDiffDays":
            guard let x = isoDate(a[0]), let y = isoDate(a[1]) else { return .err("EXPR_TYPE_ERROR", "dateDiffDays expects ISO dates.") }
            return .ok(NSNumber(value: Int(((Double(x - y)) / 86400000).rounded())))
        default: return .err("EXPR_UNKNOWN_OPERATOR", "Unknown operator \"\(op)\".")
        }
    }

    static func resolveRef(_ ref: String, _ scope: [String: Any?], _ limits: [String: Int]) -> ExprResult {
        guard let (kind, path) = parseRef(ref) else { return .err("EXPR_REFERENCE_INVALID", "Invalid reference \"\(ref)\".") }
        switch kind {
        case "field":
            let v = getPath(scope["values"] ?? nil, path)
            if let arr = v as? [Any], path.contains("*"), arr.count > limits["maxCollectionItems"]! { return .err("EXPR_LIMIT_EXCEEDED", "Wildcard projection exceeded collection budget.") }
            return .ok(v)
        case "item":
            guard let prefix = scope["rowPrefix"] as? String else { return .err("EXPR_SCOPE_ERROR", "item: reference \"\(ref)\" used outside a repeater row.") }
            return .ok(getPath(scope["values"] ?? nil, "\(prefix).\(path)"))
        case "parent":
            let full = (scope["parentPrefix"] as? String).map { "\($0).\(path)" } ?? path
            return .ok(getPath(scope["values"] ?? nil, full))
        case "index":
            guard let i = scope["rowIndex"] else { return .err("EXPR_SCOPE_ERROR", "index reference used outside a repeater row.") }
            return .ok(i)
        case "context": return .ok(getPath(scope["context"] ?? [String: Any](), path))
        case "source": return .ok((scope["sources"] as? [String: Any])?[path])
        default: return .err("EXPR_REFERENCE_INVALID", "Invalid reference \"\(ref)\".")
        }
    }

    public static func measureExpr(_ expr: [String: Any]) -> (Int, Int) {
        var nodes = 0, maxDepth = 0
        func walk(_ e: [String: Any], _ d: Int) {
            nodes += 1; if d > maxDepth { maxDepth = d }
            if e["op"] != nil, let args = e["args"] as? [[String: Any]] { for a in args { walk(a, d + 1) } }
        }
        walk(expr, 1); return (nodes, maxDepth)
    }

    public static func evaluate(_ expr: [String: Any], _ scope: [String: Any?]) -> ExprResult {
        var limits = defaultLimits
        if let l = scope["limits"] as? [String: Int] { for (k, v) in l { limits[k] = v } }
        let (nodes, depth) = measureExpr(expr)
        if nodes > limits["maxNodes"]! { return .err("EXPR_LIMIT_EXCEEDED", "Expression has \(nodes) nodes (max \(limits["maxNodes"]!)).") }
        if depth > limits["maxDepth"]! { return .err("EXPR_LIMIT_EXCEEDED", "Expression depth \(depth) exceeds max \(limits["maxDepth"]!).") }
        var budget = limits["maxNodes"]! * 4

        func evalNode(_ e: [String: Any], _ d: Int) -> ExprResult {
            budget -= 1
            if budget < 0 { return .err("EXPR_LIMIT_EXCEEDED", "Evaluation budget exhausted.") }
            if d > limits["maxDepth"]! { return .err("EXPR_LIMIT_EXCEEDED", "Depth budget exceeded.") }
            if e.keys.contains("const") { return .ok(e["const"]) }
            if let ref = e["ref"] as? String { return resolveRef(ref, scope, limits) }
            guard let op = e["op"] as? String else { return .err("EXPR_REFERENCE_INVALID", "Malformed expression node.") }
            let argsAst = (e["args"] as? [[String: Any]]) ?? []
            guard let ar = arity[op] else { return .err("EXPR_UNKNOWN_OPERATOR", "Unknown operator \"\(op)\".") }
            if argsAst.count < ar.0 || (ar.1 != -1 && argsAst.count > ar.1) { return .err("EXPR_TYPE_ERROR", "Operator \"\(op)\" has wrong arity (\(argsAst.count)).") }
            if op == "and" || op == "or" {
                for a in argsAst { let r = evalNode(a, d + 1); guard case .ok(let v) = r else { return r }; if !isBool(v) { return .err("EXPR_TYPE_ERROR", "\(op) expects booleans.") }; if op == "and" && (v as! NSNumber).boolValue == false { return .ok(NSNumber(value: false)) }; if op == "or" && (v as! NSNumber).boolValue == true { return .ok(NSNumber(value: true)) } }
                return .ok(NSNumber(value: op == "and"))
            }
            if op == "if" { let c = evalNode(argsAst[0], d + 1); guard case .ok(let v) = c else { return c }; if !isBool(v) { return .err("EXPR_TYPE_ERROR", "if expects a boolean condition.") }; return evalNode((v as! NSNumber).boolValue ? argsAst[1] : argsAst[2], d + 1) }
            if op == "coalesce" { for a in argsAst { let r = evalNode(a, d + 1); guard case .ok(let v) = r else { return r }; if v != nil { return .ok(v) } }; return .ok(nil) }
            var args: [Any?] = []
            for a in argsAst { let r = evalNode(a, d + 1); guard case .ok(let v) = r else { return r }; args.append(v) }
            return apply(op, args, limits)
        }
        return evalNode(expr, 1)
    }

    public static func evaluateBoolean(_ expr: [String: Any], _ scope: [String: Any?]) -> ExprResult {
        let r = evaluate(expr, scope)
        guard case .ok(let v) = r else { return r }
        if !isBool(v) { return .err("EXPR_TYPE_ERROR", "Condition must evaluate to a boolean.") }
        return r
    }
}
