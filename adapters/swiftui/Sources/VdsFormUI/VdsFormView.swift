#if canImport(SwiftUI)
import SwiftUI
import VdsForm

/// Observable wrapper so SwiftUI recomposes when the headless controller changes.
public final class FormControllerObservable: ObservableObject {
    public let controller: FormController
    @Published public var version = 0
    private var token: Int?

    public init(_ controller: FormController) {
        self.controller = controller
        // Store the subscription token so it can ALWAYS be removed. The previous
        // implementation registered a closure it could never unregister, leaking
        // the observer and keeping a torn-down view subscribed for the lifetime
        // of the controller.
        self.token = controller.addListener { [weak self] in
            DispatchQueue.main.async { self?.version += 1 }
        }
    }

    /// Explicit disposal for hosts that own the observable's lifecycle.
    public func unsubscribe() {
        if let token { controller.removeListener(token) }
        token = nil
    }

    deinit {
        if let token { controller.removeListener(token) }
    }
}

/// Native SwiftUI UI for the VDS form renderer. Renders every supported field
/// type, groups, repeaters, multi-step, conditions/formulas, validation errors,
/// localization and accessibility. Submission uses the injected trusted transport.
public struct VdsFormView: View {
    @ObservedObject var obs: FormControllerObservable
    var submitLabel: String
    @State private var tabIndex: [String: Int] = [:]
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
                Button(submitLabel) { Task { _ = await c.submit() } }
                    .accessibilityIdentifier("vds-submit")
                    .buttonStyle(.borderedProminent)
                    .disabled(c.isSubmitting)
            }.padding(16)
        }.onAppear { c.initialize() }
    }

    // Recursive helpers erase to AnyView at recursion points to avoid opaque
    // return-type cycles (Swift cannot infer `some View` defined in terms of itself).
    /// Renders EVERY canonical layout node type (14 in vds.form 1.0.0). Unknown
    /// nodes render an explicit notice instead of being silently stacked.
    private func layout(_ node: [String: Any]) -> AnyView {
        let type = node["type"] as? String ?? "section"
        let nodeId = node["id"] as? String ?? type
        if type == "steps" { return AnyView(steps(node["children"] as? [[String: Any]] ?? [])) }
        if type == "text" { return AnyView(Text(Validation.localize(node["text"], c.locale))) }
        if type == "divider" { return AnyView(Divider()) }
        if type == "repeater" {
            guard let ref = node["repeaterRef"] as? String, let f = field(ref) else { return AnyView(EmptyView()) }
            return AnyView(fieldView(f, f["key"] as! String))
        }
        if type == "summary" { return AnyView(summary(node)) }
        if type == "accordion" {
            let kids = node["children"] as? [[String: Any]] ?? []
            return AnyView(VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(kids.enumerated()), id: \.offset) { _, child in
                    DisclosureGroup(Validation.localize(child["title"], c.locale)) { layout(child) }
                        .accessibilityIdentifier("vds-accordion-\(nodeId)-\(child["id"] as? String ?? "")")
                }
            })
        }
        if type == "tabs" {
            let tabs = node["children"] as? [[String: Any]] ?? []
            if tabs.isEmpty { return AnyView(EmptyView()) }
            let sel = min(max(tabIndex[nodeId] ?? 0, 0), tabs.count - 1)
            return AnyView(VStack(alignment: .leading, spacing: 8) {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(Array(tabs.enumerated()), id: \.offset) { i, t in
                            Button(Validation.localize(t["title"], c.locale)) { tabIndex[nodeId] = i }
                                .accessibilityIdentifier("vds-tab-\(nodeId)-\(i)")
                                .fontWeight(i == sel ? .bold : .regular)
                        }
                    }
                }
                layout(tabs[sel])
            })
        }

        let kids = (node["children"] as? [[String: Any]] ?? []).map { AnyView(layout($0)) }
        let refs = (node["fieldRefs"] as? [String] ?? []).compactMap { fid -> AnyView? in
            guard let f = field(fid) else { return nil }
            return AnyView(fieldView(f, f["key"] as! String))
        }
        let all = refs + kids

        if type == "row" || type == "columns" {
            return AnyView(VStack(alignment: .leading, spacing: 6) {
                if let t = node["title"] { Text(Validation.localize(t, c.locale)).font(.headline) }
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(all.enumerated()), id: \.offset) { _, v in v.frame(maxWidth: .infinity, alignment: .leading) }
                }
            })
        }
        if type == "fieldset" {
            return AnyView(VStack(alignment: .leading, spacing: 8) {
                if let t = node["title"] { Text(Validation.localize(t, c.locale)).font(.headline) }
                ForEach(Array(all.enumerated()), id: \.offset) { _, v in v }
            }
            .padding(10)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray))
            .accessibilityIdentifier("vds-fieldset-\(nodeId)"))
        }
        let known: Set<String> = ["section", "group", "step", "tab"]
        return AnyView(VStack(alignment: .leading, spacing: 10) {
            if let t = node["title"] { Text(Validation.localize(t, c.locale)).font(.headline) }
            ForEach(Array(all.enumerated()), id: \.offset) { _, v in v }
            if !known.contains(type) {
                Text("Unsupported layout node: \(type)")
                    .foregroundColor(.orange)
                    .accessibilityIdentifier("vds-unsupported-layout-\(nodeId)")
            }
        })
    }

    private func summary(_ node: [String: Any]) -> AnyView {
        let refs = node["fieldRefs"] as? [String] ?? []
        let ids = refs.isEmpty ? (c.ir["fields"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String } : refs
        return AnyView(VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(ids.enumerated()), id: \.offset) { _, id in
                if let f = field(id), c.state.visibility[id] != false, f["type"] as? String != "hidden" {
                    HStack {
                        Text(Validation.localize(f["label"], c.locale))
                        Spacer()
                        Text(c.fieldValue(f["key"] as! String).map { "\($0)" } ?? "—")
                            .accessibilityIdentifier("vds-summary-value-\(id)")
                    }
                }
            }
        }.accessibilityIdentifier("vds-summary-\(node["id"] as? String ?? "root")"))
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
        if type == "group" {
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
        case "multiselect":
            let sel = Set((value as? [Any] ?? []).map { "\($0)" })
            return AnyView(VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(opts.enumerated()), id: \.offset) { _, o in
                    let v = "\(o["value"]!)"
                    Button {
                        var next = sel
                        if next.contains(v) { next.remove(v) } else { next.insert(v) }
                        c.setFieldValue(path, Array(next))
                    } label: {
                        HStack { Text(sel.contains(v) ? "☑" : "☐"); Text(Validation.localize(o["label"], c.locale)) }
                    }
                    .disabled(!enabled)
                    .accessibilityIdentifier("vds-option-\(path)-\(v)")
                }
            }.accessibilityIdentifier("vds-input-\(path)"))
        case "radio":
            return AnyView(VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(opts.enumerated()), id: \.offset) { _, o in
                    let v = "\(o["value"]!)"
                    Button { c.setFieldValue(path, v) } label: {
                        HStack { Text(value.map { "\($0)" } == v ? "◉" : "○"); Text(Validation.localize(o["label"], c.locale)) }
                    }
                    .disabled(!enabled)
                    .accessibilityIdentifier("vds-option-\(path)-\(v)")
                }
            }.accessibilityIdentifier("vds-input-\(path)"))
        case "date", "time", "datetime":
            return AnyView(dateTimeControl(path, type, value, enabled))
        case "color":
            return AnyView(colorControl(path, value, enabled))
        case "barcode":
            if c.barcode == nil {
                return AnyView(Text("Barcode scanning requires a host scanner adapter.")
                    .foregroundColor(.orange).accessibilityIdentifier("vds-input-\(path)"))
            }
            return AnyView(Button(value.map { "\($0)" } ?? "Scan barcode") {
                Task { if let code = await c.barcode?.scan() { c.setFieldValue(path, code) } }
            }.disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        case "file", "image":
            return AnyView(fileControl(f, path, enabled))
        case "signature":
            return AnyView(Text("Signature capture is not supported by the SwiftUI renderer.")
                .foregroundColor(.orange).accessibilityIdentifier("vds-input-\(path)"))
        case "integer", "decimal", "currency", "percentage", "duration":
            let num = Binding<String>(get: { value.map { "\($0)" } ?? "" }, set: { c.setFieldValue(path, type == "integer" ? (Int($0) ?? $0) : (Double($0) ?? $0)) })
            return AnyView(TextField("", text: num).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        default:
            return AnyView(TextField("", text: text).disabled(!enabled).accessibilityIdentifier("vds-input-\(path)"))
        }
    }

    // ------------------------------------------------------------ file/image

    private func fileControl(_ f: [String: Any], _ path: String, _ enabled: Bool) -> some View {
        let st = c.uploadStateFor(path)
        let v = f["validation"] as? [String: Any] ?? [:]
        let multiple = (v["multiple"] as? Bool == true) || (f["valueType"] as? String == "asset[]")
        let value = c.fieldValue(path)
        let refs: [[String: Any]] = (value as? [Any])?.compactMap { $0 as? [String: Any] }
            ?? ((value as? [String: Any]).map { [$0] } ?? [])
        let canPick = enabled && c.picker != nil && c.uploads != nil && !st.busy
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button(multiple ? "Choose files" : "Choose file") { Task { _ = await c.pickAndUpload(path) } }
                    .disabled(!canPick).accessibilityIdentifier("vds-pick-\(path)")
                if f["type"] as? String == "image", c.camera != nil {
                    Button("Camera") { Task { _ = await c.pickAndUpload(path, useCamera: true) } }
                        .disabled(!canPick).accessibilityIdentifier("vds-camera-\(path)")
                }
                if st.busy {
                    Button("Cancel") { c.cancelUpload(path) }.accessibilityIdentifier("vds-cancel-upload-\(path)")
                }
            }
            if c.picker == nil || c.uploads == nil {
                Text("File selection requires host picker and upload adapters.").font(.caption).foregroundColor(.orange)
            }
            if st.busy {
                ProgressView(value: st.fraction).accessibilityIdentifier("vds-upload-progress-\(path)")
            }
            ForEach(Array(refs.enumerated()), id: \.offset) { _, r in
                let ref = r["assetRef"] as? String ?? ""
                HStack {
                    Text(r["name"] as? String ?? "").accessibilityIdentifier("vds-asset-\(ref)")
                    Spacer()
                    Button("Remove") {
                        if multiple { c.setFieldValue(path, refs.filter { ($0["assetRef"] as? String) != ref }) }
                        else { c.setFieldValue(path, nil) }
                    }.disabled(!enabled).accessibilityIdentifier("vds-remove-asset-\(ref)")
                }
            }
            ForEach(Array(st.failures.enumerated()), id: \.offset) { _, fail in
                Text("\(fail.name): \(fail.message) [\(fail.code)]")
                    .font(.caption).foregroundColor(.red).accessibilityIdentifier("vds-upload-error-\(path)")
            }
        }.accessibilityIdentifier("vds-input-\(path)")
    }

    // -------------------------------------------------------- date/time/native

    private func dateTimeControl(_ path: String, _ type: String, _ value: Any?, _ enabled: Bool) -> some View {
        let dateBinding = Binding<Date>(
            get: { Self.parseDate(value.map { "\($0)" } ?? "") ?? Date() },
            set: { newDate in c.setFieldValue(path, Self.formatDate(newDate, type)) }
        )
        let components: DatePickerComponents = type == "date" ? [.date] : (type == "time" ? [.hourAndMinute] : [.date, .hourAndMinute])
        return DatePicker("", selection: dateBinding, displayedComponents: components)
            .disabled(!enabled)
            .accessibilityIdentifier("vds-input-\(path)")
    }

    static func parseDate(_ s: String) -> Date? {
        if s.isEmpty { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: s) { return d }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(identifier: "UTC")
        for fmt in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd", "HH:mm"] {
            df.dateFormat = fmt
            if let d = df.date(from: s) { return d }
        }
        return nil
    }

    static func formatDate(_ d: Date, _ type: String) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(identifier: "UTC")
        df.dateFormat = type == "date" ? "yyyy-MM-dd" : (type == "time" ? "HH:mm" : "yyyy-MM-dd'T'HH:mm:ss")
        return df.string(from: d)
    }

    // ---------------------------------------------------------------- colour

    static let palette = ["#000000", "#FFFFFF", "#EF4444", "#F59E0B", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899"]

    private func colorControl(_ path: String, _ value: Any?, _ enabled: Bool) -> some View {
        let current = (value.map { "\($0)" } ?? "#000000").uppercased()
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                ForEach(Self.palette, id: \.self) { hex in
                    Button { c.setFieldValue(path, hex) } label: {
                        Rectangle()
                            .fill(Self.color(hex))
                            .frame(width: 26, height: 26)
                            .border(current == hex ? Color.blue : Color.gray, width: current == hex ? 3 : 1)
                    }
                    .disabled(!enabled)
                    .accessibilityIdentifier("vds-color-\(path)-\(hex)")
                }
            }
            Text(current).font(.caption).accessibilityIdentifier("vds-color-value-\(path)")
        }.accessibilityIdentifier("vds-input-\(path)")
    }

    static func color(_ hex: String) -> Color {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let n = UInt32(h, radix: 16) ?? 0
        return Color(
            red: Double((n >> 16) & 0xFF) / 255.0,
            green: Double((n >> 8) & 0xFF) / 255.0,
            blue: Double(n & 0xFF) / 255.0
        )
    }
}
#endif
