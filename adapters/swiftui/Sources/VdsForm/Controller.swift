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
    func upload(fieldPath: String, name: String, bytes: Data, mimeType: String,
                onProgress: ((Double) -> Void)?, cancellation: UploadCancellation?) async throws -> [String: Any]
}

public extension UploadAdapter {
    /// Convenience for adapters that do not report progress.
    func upload(fieldPath: String, name: String, bytes: Data, mimeType: String) async throws -> [String: Any] {
        try await upload(fieldPath: fieldPath, name: name, bytes: bytes, mimeType: mimeType, onProgress: nil, cancellation: nil)
    }
}

public final class UploadCancellation {
    public private(set) var isCancelled = false
    public init() {}
    public func cancel() { isCancelled = true }
}

/// A file selected by the host platform (document/photo picker, camera).
public struct PickedFile {
    public let name: String
    public let bytes: Data
    public let mimeType: String?
    public let id: String?
    public let localUri: String?
    public init(name: String, bytes: Data, mimeType: String? = nil, id: String? = nil, localUri: String? = nil) {
        self.name = name; self.bytes = bytes; self.mimeType = mimeType; self.id = id; self.localUri = localUri
    }
    public var size: Int { bytes.count }
}

/// Host-injected file/image selection; no picker dependency is bundled.
public protocol FilePickerAdapter {
    func pick(image: Bool, multiple: Bool, accept: [String]?) async -> [PickedFile]
}

/// Host-injected camera capture; separate so camera is only advertised when real.
public protocol CameraAdapter {
    func capture(accept: [String]?) async -> PickedFile?
}

/// Host-injected barcode/QR scanner.
public protocol BarcodeAdapter {
    func scan() async -> String?
}

public struct UploadFailure { public let name: String; public let code: String; public let message: String
    public init(name: String, code: String, message: String) { self.name = name; self.code = code; self.message = message } }
public struct UploadBatchResult { public let uploaded: [[String: Any]]; public let failures: [UploadFailure]; public let cancelled: Bool }
public struct UploadState {
    public var busy = false; public var fraction = 0.0; public var fileName: String?
    public var failures: [UploadFailure] = []
    public init() {}
}

public final class FormController {
    public let ir: [String: Any]
    public let transport: SubmissionTransport?
    public let drafts: DraftAdapter?
    public let uploads: UploadAdapter?
    public let picker: FilePickerAdapter?
    public let camera: CameraAdapter?
    public let barcode: BarcodeAdapter?
    public var locale: String

    public private(set) var values: [String: Any]
    public private(set) var state = EffectiveState()
    public private(set) var issues: [[String: Any]] = []
    public private(set) var repeaterRows: [String: [String]] = [:]
    public var stepIndex = 0
    public private(set) var status = "idle"
    public private(set) var statusMessage: String?
    private var rowSeq = 0
    /// Token-keyed listeners so subscriptions can ALWAYS be removed. The previous
    /// closure-array design leaked: FormControllerObservable could never
    /// unsubscribe, so a disposed view kept receiving notifications.
    private var listeners: [Int: () -> Void] = [:]
    private var listenerSeq = 0

    /// Single active submission: concurrent submit() calls await the SAME attempt.
    private var inFlight: Task<[String: Any], Never>?
    private var attemptKey: String?
    private var attemptFingerprint: String?
    private var disposed = false
    public var isSubmitting: Bool { inFlight != nil }
    public var isDisposed: Bool { disposed }

    public private(set) var uploadStates: [String: UploadState] = [:]
    private var uploadCancellations: [String: UploadCancellation] = [:]
    private var seenUploadIdentities = Set<String>()
    public private(set) var draftStatus = "idle"
    public private(set) var draftMessage: String?

    public init(ir: [String: Any], initialValues: [String: Any] = [:], transport: SubmissionTransport? = nil, drafts: DraftAdapter? = nil, uploads: UploadAdapter? = nil, picker: FilePickerAdapter? = nil, camera: CameraAdapter? = nil, barcode: BarcodeAdapter? = nil, locale: String? = nil) {
        self.ir = ir
        self.values = initialValues
        self.transport = transport
        self.drafts = drafts
        self.uploads = uploads
        self.picker = picker
        self.camera = camera
        self.barcode = barcode
        self.locale = locale ?? ((ir["localization"] as? [String: Any])?["defaultLocale"] as? String ?? "en")
    }

    /// Subscribes and returns a token that MUST be passed to removeListener.
    @discardableResult
    public func addListener(_ l: @escaping () -> Void) -> Int {
        listenerSeq += 1
        listeners[listenerSeq] = l
        return listenerSeq
    }

    public func removeListener(_ token: Int) { listeners.removeValue(forKey: token) }
    public var listenerCount: Int { listeners.count }
    private func notify() { if !disposed { for l in listeners.values { l() } } }

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

    private func stable(_ v: Any?) -> String {
        if let m = v as? [String: Any] {
            return "{" + m.keys.sorted().map { "\($0):\(stable(m[$0]))" }.joined(separator: ",") + "}"
        }
        if let a = v as? [Any] { return "[" + a.map { stable($0) }.joined(separator: ",") + "]" }
        if v == nil || v is NSNull { return "null" }
        return "\(v!)"
    }

    private func fingerprint() -> String {
        values.keys.sorted().map { "\($0)=\(stable(values[$0]));" }.joined()
    }

    public func submit() async -> [String: Any] {
        if disposed { return ["status": "config-error", "code": "DISPOSED"] }
        // One active attempt: a second rapid tap awaits the first, never re-executes.
        if let task = inFlight { return await task.value }

        let found = validate()
        if found.contains(where: { $0["severity"] as? String == "error" }) {
            status = "invalid"; statusMessage = "Please correct the errors below."; notify()
            return ["status": "server-validation-failed", "issues": found]
        }
        guard let transport = transport else {
            status = "failed"; statusMessage = "No submission transport configured."; notify()
            return ["status": "config-error", "code": "NO_TRANSPORT"]
        }

        let fp = fingerprint()
        // Reuse the key only for an unresolved attempt with an UNCHANGED payload.
        let key: String
        if let existing = attemptKey, attemptFingerprint == fp { key = existing }
        else { key = "swiftui-\(Int(Date().timeIntervalSince1970 * 1000))-\(rowSeq)"; rowSeq += 1 }
        attemptKey = key; attemptFingerprint = fp

        status = "submitting"; notify()
        let task = Task<[String: Any], Never> { [weak self] in
            guard let self else { return ["status": "config-error", "code": "DISPOSED"] }
            do {
                let result = try await transport(self.ir["formId"] as! String, self.values, key)
                if !self.disposed {
                    // A definitive verdict resolves the attempt: next submit uses a new key.
                    self.attemptKey = nil; self.attemptFingerprint = nil
                    let ok = result["status"] as? String == "succeeded"
                    self.status = ok ? "succeeded" : "failed"
                    self.statusMessage = ok ? "Submitted successfully." : (result["message"] as? String ?? result["status"] as? String ?? "")
                    if result["status"] as? String == "server-validation-failed", let iss = result["issues"] as? [[String: Any]] { self.issues = iss }
                    self.notify()
                }
                return result
            } catch {
                // Unresolved: keep the key so retrying the SAME payload replays safely.
                if !self.disposed { self.status = "failed"; self.statusMessage = "\(error)"; self.notify() }
                return ["status": "config-error", "message": "\(error)"]
            }
        }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    // ---------------------------------------------------------------- uploads

    private func refsAt(_ path: String) -> [[String: Any]] {
        let cur = Expressions.getPath(values, path)
        if let arr = cur as? [Any] { return arr.compactMap { $0 as? [String: Any] } }
        if let one = cur as? [String: Any] { return [one] }
        return []
    }

    private func fieldForPath(_ path: String) -> [String: Any]? {
        for f in ir["fields"] as? [[String: Any]] ?? [] {
            guard let key = f["key"] as? String else { continue }
            if key == path { return f }
            if key.contains("[]"), path.hasPrefix(String(key.split(separator: "[").first ?? "")) { return f }
        }
        return nil
    }

    /// Shared upload-batch semantics; mirrors @vds-form/runtime uploadAssetBatch.
    public func uploadFiles(_ path: String, files: [PickedFile], source: String = "picker") async -> UploadBatchResult {
        let field = fieldForPath(path)
        let v = (field?["validation"] as? [String: Any]) ?? [:]
        let multiple = (v["multiple"] as? Bool == true) || (field?["valueType"] as? String == "asset[]")
        let accept = (v["accept"] as? [Any])?.map { "\($0)" }
        let maxSize = v["maxSizeBytes"] as? NSNumber
        var failures: [UploadFailure] = []
        var uploaded: [[String: Any]] = []

        guard let uploads else {
            return UploadBatchResult(uploaded: uploaded, failures: [UploadFailure(name: files.first?.name ?? "", code: "UPLOAD_PROVIDER_MISSING", message: "No upload adapter registered.")], cancelled: false)
        }
        if files.isEmpty { return UploadBatchResult(uploaded: uploaded, failures: failures, cancelled: false) }

        let batch = multiple ? files : Array(files.prefix(1))
        if !multiple { for extra in files.dropFirst() { failures.append(UploadFailure(name: extra.name, code: "MULTIPLE_NOT_ALLOWED", message: "Only one file is allowed.")) } }

        for r in refsAt(path) { if let ref = r["assetRef"] as? String, !ref.isEmpty { seenUploadIdentities.insert("ref:\(ref)") } }

        let cancel = UploadCancellation()
        uploadCancellations[path] = cancel
        var st = UploadState(); st.busy = true; st.fileName = batch.first?.name; st.failures = failures
        uploadStates[path] = st; notify()

        for f in batch {
            if cancel.isCancelled || disposed { break }
            if !Assets.sizeAllowed(f.size, maxSizeBytes: maxSize) {
                failures.append(UploadFailure(name: f.name, code: "ASSET_TOO_LARGE", message: "File exceeds \(maxSize ?? 0) bytes.")); continue
            }
            if !Assets.typeAllowed(name: f.name, mimeType: f.mimeType, accept: accept) {
                failures.append(UploadFailure(name: f.name, code: "ASSET_TYPE_REJECTED", message: "File type \(f.mimeType ?? f.name) is not allowed.")); continue
            }
            let identity = Assets.uploadIdentity(id: f.id, localUri: f.localUri, name: f.name, size: f.size)
            if let identity, seenUploadIdentities.contains(identity) { continue }
            do {
                let ref = try await uploads.upload(fieldPath: path, name: f.name, bytes: f.bytes, mimeType: f.mimeType ?? "application/octet-stream",
                    onProgress: { [weak self] fraction in
                        guard let self, !self.disposed, !cancel.isCancelled else { return }
                        var s = UploadState(); s.busy = true; s.fraction = fraction; s.fileName = f.name; s.failures = failures
                        self.uploadStates[path] = s; self.notify()
                    },
                    cancellation: cancel)
                // Never commit a cancelled/disposed batch even if the adapter resolved.
                if cancel.isCancelled || disposed { break }
                if let identity { seenUploadIdentities.insert(identity) }
                uploaded.append(ref)
                if multiple {
                    var live = refsAt(path)
                    if !live.contains(where: { ($0["assetRef"] as? String) == (ref["assetRef"] as? String) }) { live.append(ref) }
                    setFieldValue(path, live)
                } else { setFieldValue(path, ref) }
            } catch {
                if cancel.isCancelled || disposed { break }
                failures.append(UploadFailure(name: f.name, code: "UPLOAD_FAILED", message: "\(error)"))
            }
        }

        let cancelled = cancel.isCancelled
        uploadCancellations.removeValue(forKey: path)
        if !disposed {
            var done = UploadState(); done.fraction = 1.0; done.failures = failures
            uploadStates[path] = done; notify()
        }
        return UploadBatchResult(uploaded: uploaded, failures: failures, cancelled: cancelled)
    }

    public func pickAndUpload(_ path: String, useCamera: Bool = false) async -> UploadBatchResult {
        guard let field = fieldForPath(path) else { return UploadBatchResult(uploaded: [], failures: [], cancelled: false) }
        let v = (field["validation"] as? [String: Any]) ?? [:]
        let multiple = (v["multiple"] as? Bool == true) || (field["valueType"] as? String == "asset[]")
        let accept = (v["accept"] as? [Any])?.map { "\($0)" }
        if useCamera {
            guard let camera else {
                return UploadBatchResult(uploaded: [], failures: [UploadFailure(name: "", code: "UPLOAD_PROVIDER_MISSING", message: "No camera adapter registered.")], cancelled: false)
            }
            let shot = await camera.capture(accept: accept)
            if disposed || shot == nil { return UploadBatchResult(uploaded: [], failures: [], cancelled: shot == nil) }
            return await uploadFiles(path, files: [shot!], source: "camera")
        }
        guard let picker else {
            return UploadBatchResult(uploaded: [], failures: [UploadFailure(name: "", code: "UPLOAD_PROVIDER_MISSING", message: "No file picker adapter registered.")], cancelled: false)
        }
        let picked = await picker.pick(image: field["type"] as? String == "image", multiple: multiple, accept: accept)
        if disposed { return UploadBatchResult(uploaded: [], failures: [], cancelled: true) }
        return await uploadFiles(path, files: picked)
    }

    public func cancelUpload(_ path: String) { uploadCancellations[path]?.cancel() }
    public func uploadStateFor(_ path: String) -> UploadState { uploadStates[path] ?? UploadState() }

    // ----------------------------------------------------------------- drafts

    public func saveDraft() async {
        guard let drafts else { draftStatus = "unavailable"; draftMessage = "No draft adapter registered."; notify(); return }
        await drafts.save(formId: ir["formId"] as! String, values: values)
        if !disposed { draftStatus = "saved"; draftMessage = nil; notify() }
    }

    public func restoreDraft() async -> Bool {
        guard let drafts else { draftStatus = "unavailable"; notify(); return false }
        guard let saved = await drafts.load(formId: ir["formId"] as! String) else {
            if !disposed { draftStatus = "empty"; notify() }
            return false
        }
        if disposed { return false }
        values = saved; recompute()
        draftStatus = "restored"; draftMessage = nil; notify()
        return true
    }

    public func clearDraft() async {
        guard let drafts else { draftStatus = "unavailable"; notify(); return }
        await drafts.clear(formId: ir["formId"] as! String)
        if !disposed { draftStatus = "cleared"; draftMessage = nil; notify() }
    }

    /// Releases listeners and cancels in-flight uploads (no post-dispose writes).
    public func dispose() {
        if disposed { return }
        disposed = true
        for c in uploadCancellations.values { c.cancel() }
        uploadCancellations.removeAll()
        listeners.removeAll()
        inFlight?.cancel()
        inFlight = nil
    }

    deinit { dispose() }
}
