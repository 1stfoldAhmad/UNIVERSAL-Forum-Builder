#if canImport(SwiftUI)
import SwiftUI
import VdsForm

/// Observable wrapper so SwiftUI recomposes when the headless controller changes.
public final class FormControllerObservable: ObservableObject {
    public let controller: FormController
    @Published public var version = 0
    public init(_ controller: FormController) {
        self.controller = controller
        controller.addListener { [weak self] in DispatchQueue.main.async { self?.version += 1 } }
    }
}

/// Native SwiftUI UI for the VDS form renderer. Renders every supported field
/// type, groups, repeaters, multi-step, conditions/formulas, validation errors,
/// localization and accessibility. Submission uses the injected trusted transport.
public struct VdsFormView: View {
    @ObservedObject var obs: FormControllerObservable
    var submitLabel: String
    public init(controller: FormController, submitLabel: String = "Submit") {
        self.obs = FormControllerObservable(controller)
        self.submitLabel = submitLabel
    }
    private var c: FormController { obs.controller }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let msg = c.statusMessage {
                    Text(msg).accessibilityIdentifier("vds-status").foregroundColor(c.status == "succeeded" ? .green : .red)
                }
                layout(c.ir["layout"] as? [String: Any] ?? [:])
                Button(submitLabel) { Task { _ = await c.submit() } }.accessibilityIdentifier("vds-submit").buttonStyle(.borderedProminent)
            }.padding(16)
        }.onAppear { c.initialize() }
    }

    @ViewBuilder private func layout(_ node: [String: Any]) -> some View {
        let type = node["type"] as? String ?? "section"
        if type == "steps" { steps(node["children"] as? [[String: Any]] ?? []) }
        else if type == "text" { Text(Validation.localize(node["text"], c.locale)) }
        else if type == "divider" { Divider() }
        else {
            VStack(alignment: .leading, spacing: 10) {
                if let t = node["title"] { Text(Validation.localize(t, c.locale)).font(.headline) }
                ForEach(node["fieldRefs"] as? [String] ?? [], id: \.self) { fid in
                    if let f = field(fid) { fieldView(f, f["key"] as! String) }
                }
                ForEach(Array((node["children"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { _, child in layout(child) }
            }
        }
    }

    @ViewBuilder private func steps(_ steps: [[String: Any]]) -> some View {
        let idx = min(max(c.stepIndex, 0), max(steps.count - 1, 0))
        let current = steps.isEmpty ? [:] : steps[idx]
        VStack(alignment: .leading) {
            ProgressView(value: steps.isEmpty ? 0 : Double(idx + 1) / Double(steps.count))
            Text(Validation.localize(current["title"], c.locale).isEmpty ? "Step \(idx + 1)" : Validation.localize(current["title"], c.locale)).font(.headline)
            layout(current.merging(["type": "section" as Any]) { _, new in new })
            HStack {
                Button("Back") { c.stepIndex -= 1 }.disabled(idx == 0).accessibilityIdentifier("vds-step-prev")
                Spacer()
                Button("Next") { c.stepIndex += 1 }.disabled(idx >= steps.count - 1).accessibilityIdentifier("vds-step-next")
            }
        }
    }

    private func field(_ id: String) -> [String: Any]? {
        (c.ir["fields"] as? [[String: Any]] ?? []).first { $0["id"] as? String == id }
    }

    @ViewBuilder private func fieldView(_ f: [String: Any], _ path: String) -> some View {
        let id = f["id"] as! String
        let type = f["type"] as! String
        if type == "hidden" || c.state.visibility[id] == false { EmptyView() }
        else if type == "repeater" { repeater(f) }
        else if type == "group" {
            let kids = (c.ir["fields"] as? [[String: Any]] ?? []).filter { $0["parentId"] as? String == id }
            GroupBox(Validation.localize(f["label"], c.locale)) {
                VStack(alignment: .leading) { ForEach(Array(kids.enumerated()), id: \.offset) { _, k in fieldView(k, k["key"] as! String) } }
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(Validation.localize(f["label"], c.locale) + (c.state.required[id] == true ? " *" : ""))
                control(f, path)
                ForEach(Array(c.errorsFor(path).enumerated()), id: \.offset) { _, e in
                    Text(e["message"] as? String ?? "").font(.caption).foregroundColor(.red).accessibilityIdentifier("vds-error-\(path)")
                }
            }
        }
    }

    @ViewBuilder private func repeater(_ f: [String: Any]) -> some View {
        let id = f["id"] as! String
        let rows = c.repeaterRows[id] ?? []
        let kids = (c.ir["fields"] as? [[String: Any]] ?? []).filter { $0["parentId"] as? String == id }
        GroupBox(Validation.localize(f["label"], c.locale)) {
            VStack(alignment: .leading) {
                ForEach(Array(rows.enumerated()), id: \.element) { i, rowId in
                    VStack(alignment: .leading) {
                        ForEach(Array(kids.enumerated()), id: \.offset) { _, k in
                            fieldView(k, (k["key"] as! String).replacingOccurrences(of: "\(f["key"] as! String)[]", with: "\(f["key"] as! String).\(i)"))
                        }
                        Button("Remove") { c.removeRepeaterItem(id, rowId) }.accessibilityIdentifier("vds-remove-\(rowId)")
                    }.padding(6)
                }
                Button("Add entry") { c.addRepeaterItem(id) }.accessibilityIdentifier("vds-add-row")
            }
        }
    }

    @ViewBuilder private func control(_ f: [String: Any], _ path: String) -> some View {
        let type = f["type"] as! String
        let value = c.fieldValue(path)
        let enabled = c.state.disabled[f["id"]] != true && c.state.readonly[f["id"]] != true && f["computed"] != true
        let opts = f["options"] as? [[String: Any]] ?? []
        let validation = f["validation"] as? [String: Any] ?? [:]
        let text = Binding<String>(get: { value.map { "\($0)" } ?? "" }, set: { c.setFieldValue(path, $0) })

        switch type {
        case "textarea": TextEditor(text: text).frame(minHeight: 80).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)")
        case "select":
            Picker("", selection: Binding<String>(get: { value.map { "\($0)" } ?? "" }, set: { c.setFieldValue(path, $0) })) {
                ForEach(Array(opts.enumerated()), id: \.offset) { _, o in Text(Validation.localize(o["label"], c.locale)).tag("\(o["value"]!)") }
            }.disabled(!enabled).accessibilityIdentifier("vds-input-\(path)")
        case "checkbox", "switch", "consent":
            Toggle("", isOn: Binding<Bool>(get: { (value as? NSNumber)?.boolValue ?? false }, set: { c.setFieldValue(path, $0) })).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)")
        case "rating":
            let max = (validation["max"] as? NSNumber)?.intValue ?? 5
            let cur = (value as? NSNumber)?.intValue ?? 0
            HStack { ForEach(1...max, id: \.self) { n in Button(n <= cur ? "★" : "☆") { c.setFieldValue(path, n) }.disabled(!enabled).accessibilityIdentifier("vds-star-\(path)-\(n)") } }
        case "range":
            let mn = (validation["min"] as? NSNumber)?.doubleValue ?? 0
            let mx = (validation["max"] as? NSNumber)?.doubleValue ?? 100
            Slider(value: Binding<Double>(get: { (value as? NSNumber)?.doubleValue ?? mn }, set: { c.setFieldValue(path, $0) }), in: mn...mx).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)")
        case "computed": Text(value.map { "\($0)" } ?? "—").font(.headline).accessibilityIdentifier("vds-computed-\(path)")
        case "file", "image": Button("Choose file (upload provider)") {}.disabled(!enabled).accessibilityIdentifier("vds-input-\(path)")
        case "signature": Text("Signature capture is not supported by the SwiftUI renderer.")
        case "integer", "decimal", "currency", "percentage", "duration":
            TextField("", text: Binding<String>(get: { value.map { "\($0)" } ?? "" }, set: { c.setFieldValue(path, type == "integer" ? (Int($0) ?? $0) : (Double($0) ?? $0)) })).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)")
        default:
            TextField("", text: text).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)")
        }
    }
}
#endif
