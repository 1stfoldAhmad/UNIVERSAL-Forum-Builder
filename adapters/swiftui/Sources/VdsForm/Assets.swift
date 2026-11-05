import Foundation

/// Canonical asset (file/image) constraint semantics — Swift port.
///
/// Mirrors packages/form-validation/src/assets.ts and is proven against the
/// shared fixture packages/form-conformance/fixtures/asset-upload.json.
///
/// Extensions match the FILENAME; MIME tokens match a NORMALIZED MIME; either may
/// be inferred from the other. The size limit is inclusive.
///
/// SECURITY: client metadata is a hint, never proof of content. The trusted
/// upload/storage provider remains authoritative.
public enum Assets {
    private static let mimeAliases: [String: String] = [
        "image/jpg": "image/jpeg",
        "image/pjpeg": "image/jpeg",
        "image/x-png": "image/png",
        "application/x-pdf": "application/pdf",
        "application/acrobat": "application/pdf",
    ]

    private static let extAliases: [String: String] = ["jpg": "jpeg", "jpe": "jpeg", "tif": "tiff", "htm": "html"]

    private static let extToMime: [String: String] = [
        "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
        "bmp": "image/bmp", "heic": "image/heic", "heif": "image/heif", "svg": "image/svg+xml",
        "pdf": "application/pdf", "txt": "text/plain", "csv": "text/csv", "json": "application/json",
        "mp4": "video/mp4", "mov": "video/quicktime", "mp3": "audio/mpeg", "wav": "audio/wav",
        "zip": "application/zip", "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]

    private static let mimeToExts: [String: [String]] = {
        var out: [String: [String]] = [:]
        for (ext, mime) in extToMime { out[mime, default: []].append(extAliases[ext] ?? ext) }
        return out
    }()

    private static let genericMime = "application/octet-stream"

    public static func normalizeMimeType(_ mimeType: String?) -> String {
        guard let mimeType, !mimeType.isEmpty else { return "" }
        let base = mimeType.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        return mimeAliases[base] ?? base
    }

    public static func fileExtension(_ name: String?) -> String {
        guard let name, !name.isEmpty else { return "" }
        let base = name.split(whereSeparator: { $0 == "\\" || $0 == "/" }).last.map(String.init) ?? name
        guard let dot = base.lastIndex(of: ".") else { return "" }
        let idx = base.distance(from: base.startIndex, to: dot)
        if idx <= 0 || idx == base.count - 1 { return "" }
        let ext = String(base[base.index(after: dot)...]).lowercased()
        return extAliases[ext] ?? ext
    }

    public static func typeAllowed(name: String?, mimeType: String?, accept: [String]?) -> Bool {
        let tokens = accept ?? []
        if tokens.isEmpty { return true }

        let mime = normalizeMimeType(mimeType)
        let ext = fileExtension(name)

        var mimes = Set<String>()
        if !mime.isEmpty && mime != genericMime { mimes.insert(mime) }
        if !ext.isEmpty, let m = extToMime[ext] { mimes.insert(m) }

        var exts = Set<String>()
        if !ext.isEmpty { exts.insert(ext) }
        for e in mimeToExts[mime] ?? [] { exts.insert(e) }

        for raw in tokens {
            let token = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if token.isEmpty { continue }
            if token.hasPrefix(".") {
                let want = String(token.dropFirst())
                if exts.contains(extAliases[want] ?? want) { return true }
            } else if token.hasSuffix("/*") {
                let prefix = String(token.dropLast())
                if mimes.contains(where: { $0.hasPrefix(prefix) }) { return true }
            } else if mimes.contains(normalizeMimeType(token)) {
                return true
            }
        }
        return false
    }

    public static func sizeAllowed(_ sizeBytes: Any?, maxSizeBytes: NSNumber?) -> Bool {
        guard let maxSizeBytes else { return true }
        guard let n = sizeBytes as? NSNumber else { return true }
        return n.doubleValue <= maxSizeBytes.doubleValue
    }

    /// Reliable upload identity, or nil when none exists (never name:size).
    public static func uploadIdentity(
        assetRef: String? = nil, id: String? = nil, localUri: String? = nil,
        fingerprint: String? = nil, name: String? = nil, size: Any? = nil, lastModified: NSNumber? = nil
    ) -> String? {
        if let assetRef, !assetRef.isEmpty { return "ref:\(assetRef)" }
        if let id, !id.isEmpty { return "id:\(id)" }
        if let localUri, !localUri.isEmpty { return "uri:\(localUri)" }
        if let fingerprint, !fingerprint.isEmpty { return "fp:\(fingerprint)" }
        if let lastModified { return "file:\(name ?? ""):\(size ?? ""):\(lastModified)" }
        return nil
    }
}
