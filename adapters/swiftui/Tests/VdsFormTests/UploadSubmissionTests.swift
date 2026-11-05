import XCTest
@testable import VdsForm

/// Native upload lifecycle + single-active-submission guarantees (mission §3.4,
/// §4.5) and the shared cross-language asset conformance fixture (§3.2, §10).
final class UploadSubmissionTests: XCTestCase {
    static func fixtureDir() -> String {
        if let env = ProcessInfo.processInfo.environment["VDS_CONFORMANCE_FIXTURES"] { return env }
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("packages/form-conformance/fixtures").path
    }

    func uploadIr(multiple: Bool = true, accept: [String]? = nil, maxSize: Int? = nil) -> [String: Any] {
        var validation: [String: Any] = [:]
        if multiple { validation["multiple"] = true }
        if let accept { validation["accept"] = accept }
        if let maxSize { validation["maxSizeBytes"] = maxSize }
        return [
            "formId": "test:uploads", "specVersion": "1.0.0",
            "fields": [
                ["id": "doc", "key": "doc", "type": "file", "label": "Document",
                 "valueType": multiple ? "asset[]" : "asset", "validation": validation],
                ["id": "note", "key": "note", "type": "text", "label": "Note", "valueType": "string"],
            ],
            "layout": ["type": "section", "fieldRefs": ["doc", "note"]],
            "formulas": [], "conditions": [],
        ]
    }

    final class FakeUpload: UploadAdapter {
        var calls: [String] = []
        var seq = 0
        let failFor: Set<String>
        let ignoreCancel: Bool
        let gate: Gate?
        init(failFor: Set<String> = [], ignoreCancel: Bool = false, gate: Gate? = nil) {
            self.failFor = failFor; self.ignoreCancel = ignoreCancel; self.gate = gate
        }
        func upload(fieldPath: String, name: String, bytes: Data, mimeType: String,
                    onProgress: ((Double) -> Void)?, cancellation: UploadCancellation?) async throws -> [String: Any] {
            calls.append(name)
            onProgress?(0.5)
            if let gate { await gate.wait() }
            if failFor.contains(name) { throw NSError(domain: "test", code: 1) }
            if cancellation?.isCancelled == true && !ignoreCancel { throw NSError(domain: "UPLOAD_CANCELLED", code: 2) }
            seq += 1
            return ["assetRef": "ref-\(seq)", "name": name, "mimeType": mimeType, "sizeBytes": bytes.count]
        }
    }

    /// One-shot async gate used to hold a transport/upload open deterministically.
    actor Gate {
        private var continuation: CheckedContinuation<Void, Never>?
        private var opened = false
        private var enteredContinuation: CheckedContinuation<Void, Never>?
        private var entered = false
        func wait() async {
            if opened { return }
            await withCheckedContinuation { c in
                if entered { enteredContinuation?.resume(); enteredContinuation = nil }
                entered = true
                continuation = c
            }
        }
        func waitUntilEntered() async {
            if entered { return }
            await withCheckedContinuation { c in enteredContinuation = c }
        }
        func open() {
            opened = true
            continuation?.resume()
            continuation = nil
        }
    }

    final class MemoryDrafts: DraftAdapter {
        var store: [String: [String: Any]] = [:]
        func save(formId: String, values: [String: Any]) async { store[formId] = values }
        func load(formId: String) async -> [String: Any]? { store[formId] }
        func clear(formId: String) async { store.removeValue(forKey: formId) }
    }

    func pf(_ name: String, size: Int = 3, mime: String? = "application/pdf", id: String? = nil) -> PickedFile {
        PickedFile(name: name, bytes: Data(repeating: 65, count: size), mimeType: mime, id: id)
    }

    // ------------------------------------------------------------- conformance

    func testSharedAssetConformance() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: Self.fixtureDir() + "/asset-upload.json"))
        let suite = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var failures: [String] = []
        for c in suite["cases"] as! [[String: Any]] {
            let expect = c["expect"] as! [String: Any]
            let accept = (c["accept"] as! [Any]).map { "\($0)" }
            let gotType = Assets.typeAllowed(name: c["name"] as? String, mimeType: c["mimeType"] as? String, accept: accept)
            let gotSize = Assets.sizeAllowed(c["sizeBytes"], maxSizeBytes: c["maxSizeBytes"] as? NSNumber)
            if gotType != (expect["typeAllowed"] as! Bool) { failures.append("\(c["id"]!): type") }
            if gotSize != (expect["sizeAllowed"] as! Bool) { failures.append("\(c["id"]!): size") }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: " | "))
    }

    func testAssetHelpers() {
        XCTAssertEqual(Assets.fileExtension("photo.JPG"), "jpeg")
        XCTAssertEqual(Assets.normalizeMimeType("image/jpg"), "image/jpeg")
        XCTAssertTrue(Assets.typeAllowed(name: "p.jpg", mimeType: "image/jpeg", accept: [".jpg"]))
        XCTAssertFalse(Assets.typeAllowed(name: "p.png", mimeType: "image/png", accept: [".jpg"]))
    }

    // -------------------------------------------------------------- submission

    func testTwoRapidSubmitsExecuteTransportOnce() async throws {
        let gate = Gate()
        let counter = Counter()
        let c = FormController(ir: uploadIr(), transport: { _, _, key in
            await counter.record(key)
            await gate.wait()
            return ["status": "succeeded"]
        })
        c.initialize()

        let t1 = Task { await c.submit() }
        await gate.waitUntilEntered()
        let t2 = Task { await c.submit() }
        // Give the second call a chance to reach the single-flight guard while
        // the first attempt is still suspended inside the transport.
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(c.isSubmitting)
        await gate.open()

        let r1 = await t1.value
        let r2 = await t2.value
        let n = await counter.count
        XCTAssertEqual(n, 1, "a second tap must not start a second transport execution")
        XCTAssertEqual(r1["status"] as? String, "succeeded")
        XCTAssertEqual(r2["status"] as? String, "succeeded")
        let keys = await counter.keys
        XCTAssertEqual(keys.count, 1)
        XCTAssertFalse(c.isSubmitting)
    }

    actor Counter {
        var keys: [String] = []
        var count: Int { keys.count }
        func record(_ key: String) { keys.append(key) }
    }

    func testUnresolvedAttemptReusesKeyButEditedPayloadDoesNot() async throws {
        let counter = Counter()
        let flag = Flag()
        let c = FormController(ir: uploadIr(), transport: { _, _, key in
            await counter.record(key)
            if await flag.value { throw NSError(domain: "network", code: 1) }
            return ["status": "succeeded"]
        })
        c.initialize()
        _ = await c.submit()
        XCTAssertEqual(c.status, "failed")
        _ = await c.submit()
        var keys = await counter.keys
        XCTAssertEqual(keys[0], keys[1], "same unresolved payload must replay the same idempotency key")

        c.setFieldValue("note", "edited")
        await flag.set(false)
        _ = await c.submit()
        keys = await counter.keys
        XCTAssertNotEqual(keys[1], keys[2], "an edited payload must not reuse the old key")
    }

    actor Flag {
        var value = true
        func set(_ v: Bool) { value = v }
    }

    func testDefinitiveVerdictResolvesAttempt() async throws {
        let counter = Counter()
        let c = FormController(ir: uploadIr(), transport: { _, _, key in
            await counter.record(key)
            return ["status": "business-rejected", "message": "no"]
        })
        c.initialize()
        _ = await c.submit(); _ = await c.submit()
        let keys = await counter.keys
        XCTAssertNotEqual(keys[0], keys[1])
    }

    func testNoTransportYieldsConfigError() async {
        let c = FormController(ir: uploadIr())
        c.initialize()
        let r = await c.submit()
        XCTAssertEqual(r["status"] as? String, "config-error")
        XCTAssertEqual(r["code"] as? String, "NO_TRANSPORT")
    }

    // ----------------------------------------------------------------- uploads

    func testPartialSuccessIsPreserved() async {
        let c = FormController(ir: uploadIr(), uploads: FakeUpload(failFor: ["bad.pdf"]))
        c.initialize()
        let r = await c.uploadFiles("doc", files: [pf("ok.pdf"), pf("bad.pdf"), pf("ok2.pdf")])
        XCTAssertEqual(r.uploaded.count, 2)
        XCTAssertEqual(r.failures.first?.code, "UPLOAD_FAILED")
        XCTAssertEqual((c.fieldValue("doc") as? [Any])?.count, 2)
    }

    func testCanonicalConstraintsRejectBadFiles() async {
        let c = FormController(ir: uploadIr(accept: [".jpg"], maxSize: 5), uploads: FakeUpload())
        c.initialize()
        let r = await c.uploadFiles("doc", files: [
            pf("big.jpg", size: 9, mime: "image/jpeg"), pf("a.png", mime: "image/png"), pf("ok.jpg", mime: "image/jpeg"),
        ])
        XCTAssertEqual(r.failures.map { $0.code }, ["ASSET_TOO_LARGE", "ASSET_TYPE_REJECTED"])
        XCTAssertEqual(r.uploaded.count, 1)
    }

    func testJpgAcceptedAgainstJpgToken() async {
        let up = FakeUpload()
        let c = FormController(ir: uploadIr(accept: [".jpg"]), uploads: up)
        c.initialize()
        let r = await c.uploadFiles("doc", files: [pf("photo.jpg", mime: "image/jpeg")])
        XCTAssertTrue(r.failures.isEmpty)
        XCTAssertEqual(up.calls, ["photo.jpg"])
    }

    func testIdentityDeduplicationAndPreservation() async {
        let up = FakeUpload()
        let c = FormController(ir: uploadIr(), uploads: up)
        c.initialize()
        _ = await c.uploadFiles("doc", files: [pf("a.pdf", id: "n1")])
        _ = await c.uploadFiles("doc", files: [pf("a.pdf", id: "n1")])
        XCTAssertEqual(up.calls.count, 1)
        _ = await c.uploadFiles("doc", files: [pf("same.pdf"), pf("same.pdf")])
        XCTAssertEqual((c.fieldValue("doc") as? [Any])?.count, 3)
    }

    func testCancelMidTransferKeepsCommittedRefs() async throws {
        let gate = Gate()
        let c = FormController(ir: uploadIr(), uploads: FakeUpload(gate: gate))
        c.initialize()
        _ = await c.uploadFiles("doc", files: [pf("first.pdf")])

        let gate2 = Gate()
        let c2 = FormController(ir: uploadIr(), uploads: FakeUpload(gate: gate2))
        c2.initialize()
        _ = await c2.uploadFiles("doc", files: [pf("first.pdf")])
        let pending = Task { await c2.uploadFiles("doc", files: [pf("second.pdf")]) }
        await gate2.waitUntilEntered()
        c2.cancelUpload("doc")
        await gate2.open()
        let r = await pending.value
        XCTAssertTrue(r.cancelled)
        let refs = c2.fieldValue("doc") as? [Any]
        XCTAssertEqual(refs?.count, 1, "the cancelled upload must not be committed")
        XCTAssertEqual((refs?.first as? [String: Any])?["name"] as? String, "first.pdf")
    }

    func testProviderIgnoringCancelStillCannotCommit() async throws {
        let gate = Gate()
        let c = FormController(ir: uploadIr(), uploads: FakeUpload(ignoreCancel: true, gate: gate))
        c.initialize()
        let pending = Task { await c.uploadFiles("doc", files: [pf("a.pdf")]) }
        await gate.waitUntilEntered()
        c.cancelUpload("doc")
        await gate.open()
        let r = await pending.value
        XCTAssertTrue(r.cancelled)
        XCTAssertNil(c.fieldValue("doc"))
    }

    func testMissingUploadAdapter() async {
        let c = FormController(ir: uploadIr())
        c.initialize()
        let r = await c.uploadFiles("doc", files: [pf("a.pdf")])
        XCTAssertEqual(r.failures.first?.code, "UPLOAD_PROVIDER_MISSING")
    }

    func testSingleValueFieldRejectsExtras() async {
        let c = FormController(ir: uploadIr(multiple: false), uploads: FakeUpload())
        c.initialize()
        let r = await c.uploadFiles("doc", files: [pf("a.pdf"), pf("b.pdf")])
        XCTAssertEqual(r.failures.first?.code, "MULTIPLE_NOT_ALLOWED")
        XCTAssertTrue(c.fieldValue("doc") is [String: Any])
    }

    // ------------------------------------------------------------------ drafts

    func testDraftRoundTrip() async {
        let drafts = MemoryDrafts()
        let c = FormController(ir: uploadIr(), drafts: drafts)
        c.initialize()
        c.setFieldValue("note", "hello")
        await c.saveDraft()
        XCTAssertEqual(c.draftStatus, "saved")

        let c2 = FormController(ir: uploadIr(), drafts: drafts)
        c2.initialize()
        let restored = await c2.restoreDraft()
        XCTAssertTrue(restored)
        XCTAssertEqual(c2.fieldValue("note") as? String, "hello")
        XCTAssertEqual(c2.draftStatus, "restored")

        await c2.clearDraft()
        XCTAssertEqual(c2.draftStatus, "cleared")
        let c3 = FormController(ir: uploadIr(), drafts: drafts)
        c3.initialize()
        let empty = await c3.restoreDraft()
        XCTAssertFalse(empty)
        XCTAssertEqual(c3.draftStatus, "empty")
    }

    func testDraftWithoutAdapterIsUnavailable() async {
        let c = FormController(ir: uploadIr())
        c.initialize()
        await c.saveDraft()
        XCTAssertEqual(c.draftStatus, "unavailable")
    }

    // ---------------------------------------------------- listener lifecycle

    func testListenerCanBeRemovedAndDisposeClearsAll() {
        let c = FormController(ir: uploadIr())
        c.initialize()
        var hits = 0
        let token = c.addListener { hits += 1 }
        c.setFieldValue("note", "a")
        XCTAssertEqual(hits, 1)
        c.removeListener(token)
        c.setFieldValue("note", "b")
        XCTAssertEqual(hits, 1, "a removed listener must not fire")
        XCTAssertEqual(c.listenerCount, 0)

        c.addListener { hits += 1 }
        c.dispose()
        c.setFieldValue("note", "c")
        XCTAssertEqual(hits, 1, "no notifications after dispose")
        XCTAssertEqual(c.listenerCount, 0)
    }
}
