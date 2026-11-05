import Foundation

/// Headless form controller — Swift port of @vds-form/runtime. Conditions,
/// formulas, repeaters, validation, multi-step. Submission is delegated to an
/// injected trusted transport; the client never executes business operations.

public typealias SubmissionTransport = (_ formId: String, _ values: [String: Any], _ idempotencyKey: String) async throws -> [String: Any]

public protocol DraftAdapter {
    func save(formId: String, values: [String: Any]) async
    func load(formId: String) async -> [String: Any]?
    func clear(formId: String) async
}

public protocol UploadAdapter {
    func upload(fieldPath: String, name: String, bytes: Data, mimeType: String) async throws -> [String: Any]
}

public final class FormController {
    public let ir: [String: Any]
    public let transport: SubmissionTransport?
    public let drafts: DraftAdapter?
    public let uploads: UploadAdapter?
    public var locale: String

    public private(set) var values: [String: Any]
    public private(set) var state = EffectiveState()
    public private(set) var issues: [[String: Any]] = []
    public private(set) var repeaterRows: [String: [String]] = [:]
    public var stepIndex = 0
    public private(set) var status = "idle"
    public private(set) var statusMessage: String?
    private var rowSeq = 0
    private var retryPayload: Data?
    private var retryKey: String?
    private var listeners: [() -> Void] = []

    public init(ir: [String: Any], initialValues: [String: Any] = [:], transport: SubmissionTransport? = nil, drafts: DraftAdapter? = nil, uploads: UploadAdapter? = nil, locale: String? = nil) {
        self.ir = ir
        self.values = initialValues
        self.transport = transport
        self.drafts = drafts
        self.uploads = uploads
        self.locale = locale ?? ((ir["localization"] as? [String: Any])?["defaultLocale"] as? String ?? "en")
    }

    public func addListener(_ l: @escaping () -> Void) { listeners.append(l) }
    private func notify() { for l in listeners { l() } }

    public func initialize() {
        let fields = ir["fields"] as? [[String: Any]] ?? []
        for f in fields {
            if f["parentId"] != nil || f["repeaterId"] != nil { continue }
            if f.keys.contains("defaultValue"), Expressions.getPath(values, f["key"] as! String) == nil {
                values = Validation.setIn(values, f["key"] as! String, f["defaultValue"])
            }
        }
        for f in fields where f["type"] as? String == "repeater" {
            let rows = Expressions.getPath(values, f["key"] as! String)
            var list = (rows as? [Any]) ?? []
            let min = ((f["validation"] as? [String: Any])?["minItems"] as? NSNumber ?? f["minItems"] as? NSNumber ?? NSNumber(value: 0)).intValue
            while list.count < min { list.append([String: Any]()) }
            values = Validation.setIn(values, f["key"] as! String, list)
            var ids: [String] = []
            for _ in 0..<list.count { ids.append("row-\(rowSeq)"); rowSeq += 1 }
            repeaterRows[f["id"] as! String] = ids
        }
        recompute()
    }

    private func recompute() {
        let formulas = ir["formulas"] as? [[String: Any]] ?? []
        for _ in 0...formulas.count {
            var changed = false
            for formula in formulas {
                let target = formula["target"] as! String
                if target.contains("[]") {
                    let repKey = target.components(separatedBy: "[]")[0].trimmingCharacters(in: CharacterSet(charactersIn: "."))
                    let rows = Expressions.getPath(values, repKey)
                    let n = (rows as? [Any])?.count ?? 0
                    for i in 0..<n {
                        let concrete = target.replacingOccurrences(of: "[]", with: ".\(i)", options: [], range: target.range(of: "[]"))
                        let r = Expressions.evaluate(formula["expr"] as! [String: Any], ["values": values, "rowPrefix": "\(repKey).\(i)", "rowIndex": i])
                        if case .ok(let v) = r, !Expressions.deepEqual(Expressions.getPath(values, concrete), v) { values = Validation.setIn(values, concrete, v); changed = true }
                    }
                } else {
                    let r = Expressions.evaluate(formula["expr"] as! [String: Any], ["values": values])
                    if case .ok(let v) = r, !Expressions.deepEqual(Expressions.getPath(values, target), v) { values = Validation.setIn(values, target, v); changed = true }
                }
            }
            if !changed { break }
        }
        state = Validation.computeEffectiveState(ir, values)
    }

    public func fieldValue(_ path: String) -> Any? { Expressions.getPath(values, path) }

    public func setFieldValue(_ path: String, _ value: Any?) { values = Validation.setIn(values, path, value); recompute(); notify() }

    public func addRepeaterItem(_ repeaterId: String) {
        let f = (ir["fields"] as! [[String: Any]]).first { $0["id"] as? String == repeaterId }!
        var rows = (Expressions.getPath(values, f["key"] as! String) as? [Any]) ?? []
        rows.append([String: Any]())
        values = Validation.setIn(values, f["key"] as! String, rows)
        let id = "row-\(rowSeq)"; rowSeq += 1
        repeaterRows[repeaterId, default: []].append(id)
        recompute(); notify()
    }

    public func removeRepeaterItem(_ repeaterId: String, _ rowId: String) {
        let f = (ir["fields"] as! [[String: Any]]).first { $0["id"] as? String == repeaterId }!
        guard var ids = repeaterRows[repeaterId], let idx = ids.firstIndex(of: rowId) else { return }
        var rows = (Expressions.getPath(values, f["key"] as! String) as? [Any]) ?? []
        rows.remove(at: idx); ids.remove(at: idx)
        repeaterRows[repeaterId] = ids
        values = Validation.setIn(values, f["key"] as! String, rows)
        recompute(); notify()
    }

    public func moveRepeaterItem(_ repeaterId: String, from: Int, to: Int) {
        let f = (ir["fields"] as! [[String: Any]]).first { $0["id"] as? String == repeaterId }!
        guard var ids = repeaterRows[repeaterId] else { return }
        var rows = (Expressions.getPath(values, f["key"] as! String) as? [Any]) ?? []
        if from < 0 || to < 0 || from >= rows.count || to >= rows.count { return }
        let item = rows.remove(at: from); rows.insert(item, at: to)
        let id = ids.remove(at: from); ids.insert(id, at: to)
        repeaterRows[repeaterId] = ids
        values = Validation.setIn(values, f["key"] as! String, rows)
        recompute(); notify()
    }

    @discardableResult
    public func validate() -> [[String: Any]] { issues = Validation.validateValues(ir, values, state, locale: locale); notify(); return issues }

    public func errorsFor(_ path: String) -> [[String: Any]] { issues.filter { $0["path"] as? String == path && $0["severity"] as? String == "error" } }

    public func submit() async -> [String: Any] {
        if status == "submitting" { return ["status": "business-rejected", "code": "SUBMISSION_IN_PROGRESS", "message": "A submission is already in progress."] }
        let found = validate()
        if found.contains(where: { $0["severity"] as? String == "error" }) {
            status = "invalid"; statusMessage = "Please correct the errors below."; notify()
            return ["status": "server-validation-failed", "issues": found]
        }
        guard let transport = transport else { status = "failed"; statusMessage = "No submission transport configured."; notify(); return ["status": "config-error", "code": "NO_TRANSPORT"] }
        status = "submitting"; notify()
        let signature = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys, .fragmentsAllowed])
        if retryPayload != signature || retryKey == nil {
            retryPayload = signature
            retryKey = "swiftui-\(Int(Date().timeIntervalSince1970 * 1000))-\(rowSeq)"
            rowSeq += 1
        }
        let key = retryKey!
        do {
            let result = try await transport(ir["formId"] as! String, values, key)
            let ok = result["status"] as? String == "succeeded"
            status = ok ? "succeeded" : "failed"
            if ok { retryPayload = nil; retryKey = nil }
            statusMessage = ok ? "Submitted successfully." : (result["message"] as? String ?? result["status"] as? String ?? "")
            if result["status"] as? String == "server-validation-failed", let iss = result["issues"] as? [[String: Any]] { issues = iss }
            notify(); return result
        } catch {
            status = "failed"; statusMessage = "\(error)"; notify(); return ["status": "config-error", "message": "\(error)"]
        }
    }

    public func saveDraft() async { await drafts?.save(formId: ir["formId"] as! String, values: values) }
}
