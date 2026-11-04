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

    // Recursive helpers erase to AnyView at recursion points to avoid opaque
    // return-type cycles (Swift cannot infer `some View` defined in terms of itself).
    private func layout(_ node: [String: Any]) -> AnyView {
        let type = node["type"] as? String ?? "section"
        if type == "steps" { return AnyView(steps(node["children"] as? [[String: Any]] ?? [])) }
        if type == "text" { return AnyView(Text(Validation.localize(node["text"], c.locale))) }
        if type == "divider" { return AnyView(Divider()) }
        let kids = (node["children"] as? [[String: Any]] ?? []).map { AnyView(layout($0)) }
        let refs = (node["fieldRefs"] as? [String] ?? []).compactMap { fid -> AnyView? in
            guard let f = field(fid) else { return nil }
            return AnyView(fieldView(f, f["key"] as! String))
        }
        return AnyView(VStack(alignment: .leading, spacing: 10) {
            if let t = node["title"] { Text(Validation.localize(t, c.locale)).font(.headline) }
            ForEach(Array(refs.enumerated()), id: \.offset) { _, v in v }
            ForEach(Array(kids.enumerated()), id: \.offset) { _, v in v }
        })
    }

    private func steps(_ steps: [[String: Any]]) -> AnyView {
        let idx = min(max(c.stepIndex, 0), max(steps.count - 1, 0))
        let current = steps.isEmpty ? [:] : steps[idx]
        let title = Validation.localize(current["title"], c.locale)
        return AnyView(VStack(alignment: .leading) {
            ProgressView(value: steps.isEmpty ? 0.0 : Double(idx + 1) / Double(steps.count))
            Text(title.isEmpty ? "Step \(idx + 1)" : title).font(.headline)
            layout(current.merging(["type": "section" as Any]) { _, new in new })
            HStack {
                Button("Back") { c.stepIndex -= 1 }.disabled(idx == 0).accessibilityIdentifier("vds-step-prev")
                Spacer()
                Button("Next") { c.stepIndex += 1 }.disabled(idx >= steps.count - 1).accessibilityIdentifier("vds-step-next")
            }
        })
    }

    private func field(_ id: String) -> [String: Any]? {
        (c.ir["fields"] as? [[String: Any]] ?? []).first { $0["id"] as? String == id }
    }

    private func fieldView(_ f: [String: Any], _ path: String) -> AnyView {
        let id = f["id"] as! String
        let type = f["type"] as! String
        if type == "hidden" || c.state.visibility[id] == false { return AnyView(EmptyView()) }
        if type == "repeater" { return AnyView(repeater(f)) }
        if type == "group"] {
            let kids = (c.ir["fields"] as? [[String: Any]] ?? []).filter { $0["parentId"] as? String == id }
            return AnyView(GroupBox(Validation.localize(f["label"], c.locale)) {
                VStack(alignment: .leading) {
                    ForEach(Array(kids.enumerated()), id: \.offset) { _, k in AnyView(fieldView(k, k["key"] as! String)) }
                }
            })
        }
        let errors = c.errorsFor(path).map { AnyView(Text($0["message"] as? String ?? "").font(.caption).foregroundColor(.red).accessibilityIdentifier("vds-error-\(path)")) }
        let required = c.state.required[id] == true
        return AnyView(VStack(alignment: .leading, spacing: 4) {
            Text(Validation.localize(f["label"], c.locale) + (required ? " *" : ""))
            control(f, path)
            ForEach(Array(errors.enumerated()), id: \.offset) { _, v in v }
        })
    }

    private func repeater(_ f: [String: Any]) -> AnyView {
        let id = f["id"] as! String
        let rows = c.repeaterRows[id] ?? []
        let kids = (c.ir["fields"] as? [[String: Any]] ?? []).filter { $0["parentId"] as? String == id }
        let key = f["key"] as! String
        return AnyView(GroupBox(Validation.localize(f["label"], c.locale)) {
            VStack(alignment: .leading) {
                ForEach(Array(rows.enumerated()), id: \.element) { i, rowId in
                    VStack(alignment: .leading) {
                        ForEach(Array(kids.enumerated()), id: \.offset) { _, k in
                            AnyView(fieldView(k, (k["key"] as! String).replacingOccurrences(of: "\(key)[]", with: "\(key).\(i)")))
                        }
                        Button("Remove") { c.removeRepeaterItem(id, rowId) }.accessibilityIdentifier("vds-remove-\(rowId)")
                    }.padding(6)
                }
                Button("Add entry") { c.addRepeaterItem(id) }.accessibilityIdentifier("vds-add-row")
            }
        })
    }

    private func control(_ f: [String: Any], _ path: String) -> AnyView {
        let type = f["type"] as! String
        let fid = f["id"] as! String
        let value = c.fieldValue(path)
        let computed = (f["computed"] as? NSNumber)?.boolValue ?? false
        let enabled = c.state.disabled[fid] != true && c.state.readonly[fid] != true && !computed
        let opts = f["options"] as? [[String: Any]] ?? []
        let validation = f["validation"] as? [String: Any] ?? [:]
        let text = Binding<String>(get: { value.map { "\($0)" } ?? "" }, set: { c.setFieldValue(path, $0) })

        switch type {
        case "textarea":
            return AnyView(TextEditor(text: text).frame(minHeight: 80).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        case "select":
            let sel = Binding<String>(get: { value.map { "\($0)" } ?? "" }, set: { c.setFieldValue(path, $0) })
            return AnyView(Picker("", selection: sel) {
                ForEach(Array(opts.enumerated()), id: \.offset) { _, o in Text(Validation.localize(o["label"], c.locale)).tag("\(o["value"]!)") }
            }.disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        case "checkbox", "switch", "consent":
            let on = Binding<Bool>(get: { (value as? NSNumber)?.boolValue ?? false }, set: { c.setFieldValue(path, $0) })
            return AnyView(Toggle("", isOn: on).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        case "rating":
            let max = max(1, (validation["max"] as? NSNumber)?.intValue ?? 5)
            let cur = (value as? NSNumber)?.intValue ?? 0
            return AnyView(HStack { ForEach(1...max, id: \.self) { n in Button(n <= cur ? "★" : "☆") { c.setFieldValue(path, n) }.disabled(!enabled).accessibilityIdentifier("vds-star-\(path)-\(n)") } })
        case "range":
            let mn = (validation["min"] as? NSNumber)?.doubleValue ?? 0
            let mx = (validation["max"] as? NSNumber)?.doubleValue ?? 100
            let v = Binding<Double>(get: { (value as? NSNumber)?.doubleValue ?? mn }, set: { c.setFieldValue(path, $0) })
            return AnyView(Slider(value: v, in: mn...mx).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        case "computed":
            return AnyView(Text(value.map { "\($0)" } ?? "—").font(.headline).accessibilityIdentifier("vds-computed-\(path)"))
        case "file", "image":
            return AnyView(Button("Choose file (upload provider)") {}.disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        case "signature":
            return AnyView(Text("Signature capture is not supported by the SwiftUI renderer."))
        case "integer", "decimal", "currency", "percentage", "duration":
            let num = Binding<String>(get: { value.map { "\($0)" } ?? "" }, set: { c.setFieldValue(path, type == "integer" ? (Int($0) ?? $0) : (Double($0) ?? $0)) })
            return AnyView(TextField("", text: num).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        default:
            return AnyView(TextField("", text: text).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        }
    }
}
#endif
