import XCTest
@testable import VdsForm

/// The checked-in JSON mirror must equal the language-native manifest, so the
/// generated support matrix can never drift from what the renderer declares.
final class CapabilitiesTests: XCTestCase {
    static func capabilitiesDir() -> String {
        if let env = ProcessInfo.processInfo.environment["VDS_CAPABILITIES"] { return env }
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("specifications/capabilities").path
    }

    func testManifestMatchesMirror() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: Self.capabilitiesDir() + "/swiftui.json"))
        let mirror = try JSONSerialization.jsonObject(with: data) as! NSDictionary
        let manifest = Capabilities.manifest() as NSDictionary
        XCTAssertEqual(mirror, manifest, "SwiftUI manifest drifted from specifications/capabilities/swiftui.json")
    }

    func testEveryCanonicalLayoutNodeIsDeclared() {
        XCTAssertEqual(Capabilities.layoutNodes.count, 14)
        let layout = Capabilities.manifest()["layoutStatus"] as! [String: Any]
        XCTAssertEqual(Set(layout.keys), Set(Capabilities.layoutNodes))
    }

    func testBooleanShorthandAgreesWithStatus() {
        let features = Capabilities.manifest()["features"] as! [String: Bool]
        let statuses = Capabilities.manifest()["featureStatus"] as! [String: [String: Any]]
        for (key, value) in features {
            guard let detail = statuses[key] else { return XCTFail("feature \(key) has no explicit status") }
            XCTAssertEqual(detail["status"] as? String == "supported", value, "feature \(key) boolean disagrees with its status")
        }
    }

    func testHostDependentCapabilitiesAreNotAdvertisedAsSupported() {
        let statuses = Capabilities.manifest()["featureStatus"] as! [String: [String: Any]]
        for key in ["filePicker", "camera", "barcode", "draftPersistence"] {
            XCTAssertEqual(statuses[key]?["status"] as? String, "requires-host-adapter")
            XCTAssertFalse((statuses[key]?["requires"] as? [String] ?? []).isEmpty)
        }
        XCTAssertEqual(statuses["offlineQueue"]?["status"] as? String, "unsupported")
        XCTAssertEqual(statuses["signature"]?["status"] as? String, "unsupported")
        XCTAssertFalse(Capabilities.supported.contains("signature"))
    }
}
