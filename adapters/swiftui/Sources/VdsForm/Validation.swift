import Foundation

/// Effective state + validation — Swift port. Operates on the compiled FormIR.

public struct EffectiveState {
    public var visibility: [String: Bool] = [:]
    public var required: [String: Bool] = [:]
    public var disabled: [String: Bool] = [:]
    public var readonly: [String: Bool] = [:]
}

public struct FieldInstance {
    public let field: [String: Any]
    public let concreteKey: String
}

public enum Validation {
    static let formatPatterns: [String: NSRegularExpression] = [
        "email": try! NSRegularExpression(pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$"),
        "url": try! NSRegularExpression(pattern: "^https?://[^\\s/$.?#].[^\\s]*$", options: [.caseInsensitive]),
        "phone": try! NSRegularExpression(pattern: "^\\+?[0-9\\s\\-().]{6,20}$"),
        "date": try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}$"),
        "uuid": try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive]),
    ]

    public static func localize(_ text: Any?, _ locale: String, fallback: String = "en") -> String {
        if text == nil { return "" }
        if let s = text as? String { return s }
        if let m = text as? [String: Any] { return (m[locale] as? String) ?? (m[fallback] as? String) ?? (m.values.first as? String ?? "") }
        return "\(text!)"
    }

    public static func setIn(_ root: [String: Any], _ path: String, _ value: Any?) -> [String: Any] {
        let segments = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        func recur(_ node: Any?, _ i: Int) -> Any? {
            if i == segments.count { return value }
            let seg = segments[i]
            if Expressions.matches(Expressions.digits, seg) {
                var arr = (node as? [Any]) ?? []
                let idx = Int(seg)!
                while arr.count <= idx { arr.append(NSNull()) }
                arr[idx] = recur(arr[idx], i + 1) ?? NSNull()
                return arr
            }
            var obj = (node as? [String: Any]) ?? [:]
            obj[seg] = recur(obj[seg], i + 1)
            return obj
        }
        return recur(root, 0) as? [String: Any] ?? [:]
    }

    static func bool(_ v: Any?) -> Bool { (v as? NSNumber)?.boolValue ?? false }

    public static func computeEffectiveState(_ ir: [String: Any], _ values: [String: Any], context: [String: Any] = [:], sources: [String: Any] = [:]) -> EffectiveState {
        var state = EffectiveState()
        let fields = ir["fields"] as? [[String: Any]] ?? []
        for f in fields {
            let id = f["id"] as! String
            state.visibility[id] = !bool(f["hidden"])
            state.required[id] = bool(f["required"])
            state.disabled[id] = bool(f["disabled"])
            state.readonly[id] = bool(f["readonly"])
        }
        for c in ir["conditions"] as? [[String: Any]] ?? [] {
            let r = Expressions.evaluateBoolean(c["when"] as! [String: Any], ["values": values, "context": context, "sources": sources])
            guard case .ok(let v) = r, bool(v) else { continue }
            for eff in c["effects"] as? [[String: Any]] ?? [] {
                let s = eff["set"] as? [String: Any] ?? [:]
                let fid = eff["fieldId"] as! String
                if s.keys.contains("visible") { state.visibility[fid] = bool(s["visible"]) }
                if s.keys.contains("required") { state.required[fid] = bool(s["required"]) }
                if s.keys.contains("disabled") { state.disabled[fid] = bool(s["disabled"]) }
                if s.keys.contains("readonly") { state.readonly[fid] = bool(s["readonly"]) }
            }
        }
        return state
    }

    public static func expandFieldInstances(_ ir: [String: Any], _ values: [String: Any]) -> [FieldInstance] {
        var out: [FieldInstance] = []
        let fields = ir["fields"] as? [[String: Any]] ?? []
        var repeaters: [String: [String: Any]] = [:]
        for f in fields where f["type"] as? String == "repeater" { repeaters[f["id"] as! String] = f }
        for f in fields {
            let type = f["type"] as? String
            if type == "repeater" || type == "group" { out.append(FieldInstance(field: f, concreteKey: f["key"] as! String)) }
            guard let repId = f["repeaterId"] as? String else {
                if type != "repeater" && type != "group" { out.append(FieldInstance(field: f, concreteKey: f["key"] as! String)) }
                continue
            }
            guard let rep = repeaters[repId] else { continue }
            let rows = Expressions.getPath(values, rep["key"] as! String)
            let n = (rows as? [Any])?.count ?? 0
            for i in 0..<n { out.append(FieldInstance(field: f, concreteKey: (f["key"] as! String).replacingOccurrences(of: "[]", with: ".\(i)"))) }
        }
        return out
    }

    public static func isEmptyValue(_ v: Any?) -> Bool {
        if v == nil || v is NSNull { return true }
        if let s = v as? String { return s.isEmpty }
        if let a = v as? [Any] { return a.isEmpty }
        if let o = v as? [String: Any] { return o.isEmpty }
        return false
    }

    static func issue(_ code: String, _ message: String, _ path: String, _ fieldId: String? = nil) -> [String: Any] {
        var m: [String: Any] = ["code": code, "message": message, "path": path, "severity": "error", "source": "field"]
        if let f = fieldId { m["fieldId"] = f }
        return m
    }

    public static func validateValues(_ ir: [String: Any], _ values: [String: Any], _ state: EffectiveState, phase: String = "submit", locale: String = "en") -> [[String: Any]] {
        var issues: [[String: Any]] = []
        for inst in expandFieldInstances(ir, values) {
            let f = inst.field; let id = f["id"] as! String
            if state.visibility[id] == false { continue }
            let v = Expressions.getPath(values, inst.concreteKey)
            let label = localize(f["label"], locale)
            if state.required[id] == true && isEmptyValue(v) { issues.append(issue("REQUIRED", "\(label) is required.", inst.concreteKey, id)); continue }
            if isEmptyValue(v) { continue }
            let val = f["validation"] as? [String: Any] ?? [:]
            let vt = f["valueType"] as? String ?? "string"
            if vt == "number" && !Expressions.isNum(v) { issues.append(issue("TYPE", "\(label) must be a number.", inst.concreteKey, id)) }
            if let n = v as? NSNumber, Expressions.isNum(n) {
                if let mn = val["min"] as? NSNumber, n.doubleValue < mn.doubleValue { issues.append(issue("MIN", "\(label) must be ≥ \(mn).", inst.concreteKey, id)) }
                if let mx = val["max"] as? NSNumber, n.doubleValue > mx.doubleValue { issues.append(issue("MAX", "\(label) must be ≤ \(mx).", inst.concreteKey, id)) }
            }
            if let s = v as? String {
                if let mn = val["minLength"] as? NSNumber, s.count < mn.intValue { issues.append(issue("MIN_LENGTH", "\(label) is too short.", inst.concreteKey, id)) }
                if let mx = val["maxLength"] as? NSNumber, s.count > mx.intValue { issues.append(issue("MAX_LENGTH", "\(label) is too long.", inst.concreteKey, id)) }
                if let p = val["pattern"] as? String, p.count <= 1000, let re = try? NSRegularExpression(pattern: p), re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) == nil { issues.append(issue("PATTERN", "\(label) has an invalid format.", inst.concreteKey, id)) }
                if let fmt = val["format"] as? String, let re = formatPatterns[fmt], re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) == nil { issues.append(issue("FORMAT", "\(label) has an invalid format.", inst.concreteKey, id)) }
            }
            if let arr = v as? [Any] {
                if let mn = val["minItems"] as? NSNumber, arr.count < mn.intValue { issues.append(issue("MIN_ITEMS", "\(label) needs more entries.", inst.concreteKey, id)) }
                if let mx = val["maxItems"] as? NSNumber, arr.count > mx.intValue { issues.append(issue("MAX_ITEMS", "\(label) has too many entries.", inst.concreteKey, id)) }
            }
        }
        for rule in ir["crossFieldRules"] as? [[String: Any]] ?? [] {
            let r = Expressions.evaluateBoolean(rule["expr"] as! [String: Any], ["values": values])
            if case .ok(let v) = r, !bool(v) { issues.append(issue("CROSS_FIELD", localize(rule["message"], locale), rule["path"] as? String ?? "")) }
        }
        return issues
    }
}
