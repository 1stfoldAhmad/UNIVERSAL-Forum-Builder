import XCTest
@testable import VdsForm

final class ControllerTest: XCTestCase {
    static func irFixtures() -> String {
        if let env = ProcessInfo.processInfo.environment["VDS_IR_FIXTURES"] { return env }
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("execution-adapters/laravel/tests/fixtures/ir").path
    }

    func loadIr(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: URL(fileURLWithPath: Self.irFixtures() + "/\(name).ir.json"))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    func testFormulas() throws {
        let c = FormController(ir: try loadIr("invoice"), initialValues: ["items": [
            ["description": "A", "qty": 2, "price": 5], ["description": "B", "qty": 3, "price": 4],
        ]])
        c.initialize()
        XCTAssertEqual((c.fieldValue("items.0.lineTotal") as? NSNumber)?.doubleValue, 10)
        XCTAssertEqual((c.fieldValue("subtotal") as? NSNumber)?.doubleValue, 22)
        XCTAssertNotNil(c.fieldValue("total"))
    }

    func testConditions() throws {
        let c = FormController(ir: try loadIr("customer-registration"))
        c.initialize()
        XCTAssertEqual(c.state.visibility["companyName"], false)
        c.setFieldValue("customer.type", "business")
        XCTAssertEqual(c.state.visibility["companyName"], true)
        XCTAssertEqual(c.state.required["companyName"], true)
    }

    func testRepeaters() throws {
        let c = FormController(ir: try loadIr("invoice"))
        c.initialize()
        let before = (c.fieldValue("items") as? [Any])?.count ?? 0
        c.addRepeaterItem("items")
        XCTAssertEqual((c.fieldValue("items") as? [Any])?.count, before + 1)
        let rowId = c.repeaterRows["items"]!.last!
        c.removeRepeaterItem("items", rowId)
        XCTAssertEqual((c.fieldValue("items") as? [Any])?.count, before)
    }

    func testValidationBlocksSubmit() async throws {
        let c = FormController(ir: try loadIr("customer-registration"))
        c.initialize()
        let issues = c.validate()
        XCTAssertTrue(issues.contains { $0["code"] as? String == "REQUIRED" })
        let result = await c.submit()
        XCTAssertEqual(result["status"] as? String, "server-validation-failed")
    }

    func testSubmitDelegatesToTransport() async throws {
        var sent: [String: Any]?
        let c = FormController(
            ir: try loadIr("customer-registration"),
            initialValues: ["customer": ["name": "Ada Lovelace", "email": "ada@example.com", "type": "individual", "consent": true]],
            transport: { _, values, _ in sent = values; return ["status": "succeeded"] }
        )
        c.initialize()
        let result = await c.submit()
        XCTAssertEqual(result["status"] as? String, "succeeded")
        XCTAssertNotNil(sent)
        XCTAssertEqual(c.status, "succeeded")
    }

    func testCapabilities() {
        let m = Capabilities.manifest()
        XCTAssertEqual(m["target"] as? String, "swiftui")
        let ft = m["fieldTypes"] as! [String: Any]
        XCTAssertNotNil(ft["text"])
        XCTAssertNil(ft["signature"])
    }
}
