import XCTest
@testable import VdsForm

final class ExprConformanceTest: XCTestCase {
    static func fixturesDir() -> String {
        if let env = ProcessInfo.processInfo.environment["VDS_CONFORMANCE_FIXTURES"] { return env }
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() } // → repo root
        return url.appendingPathComponent("packages/form-conformance/fixtures").path
    }

    func testExpressionConformance() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: Self.fixturesDir() + "/expressions.json"))
        let suite = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let cases = suite["cases"] as! [[String: Any]]
        var failures: [String] = []
        for c in cases {
            let scope = (c["scope"] as? [String: Any]) ?? [:]
            let expr = c["expr"] as! [String: Any]
            let expect = c["expect"] as! [String: Any]
            let result = Expressions.evaluate(expr, scope.mapValues { $0 as Any? })
            if (expect["ok"] as? NSNumber)?.boolValue == true {
                guard case .ok(let v) = result else { failures.append("\(c["id"]!): expected ok, got \(result.code ?? "")"); continue }
                if !Expressions.deepEqual(v, expect["value"]) { failures.append("\(c["id"]!): expected \(expect["value"]!), got \(v ?? "nil")") }
            } else {
                guard case .err(let code, _) = result else { failures.append("\(c["id"]!): expected error \(expect["code"]!), got ok"); continue }
                if code != expect["code"] as? String { failures.append("\(c["id"]!): expected \(expect["code"]!), got \(code)") }
            }
        }
        XCTAssertTrue(failures.isEmpty, "\(cases.count) cases, failures: " + failures.joined(separator: " | "))
    }
}
