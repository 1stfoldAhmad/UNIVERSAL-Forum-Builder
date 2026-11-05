package dev.vdsform

/**
 * Canonical asset (file/image) constraint semantics — Kotlin port.
 *
 * Mirrors packages/form-validation/src/assets.ts and is proven against the
 * shared fixture packages/form-conformance/fixtures/asset-upload.json.
 *
 * Extensions match the FILENAME; MIME tokens match a NORMALIZED MIME; either may
 * be inferred from the other. The size limit is inclusive.
 *
 * SECURITY: client metadata is a hint, never proof of content. The trusted
 * upload/storage provider remains authoritative.
 */
object Assets {
    private val MIME_ALIASES = mapOf(
        "image/jpg" to "image/jpeg",
        "image/pjpeg" to "image/jpeg",
        "image/x-png" to "image/png",
        "application/x-pdf" to "application/pdf",
        "application/acrobat" to "application/pdf",
    )

    private val EXT_ALIASES = mapOf("jpg" to "jpeg", "jpe" to "jpeg", "tif" to "tiff", "htm" to "html")

    private val EXT_TO_MIME = mapOf(
        "jpeg" to "image/jpeg", "png" to "image/png", "gif" to "image/gif", "webp" to "image/webp",
        "bmp" to "image/bmp", "heic" to "image/heic", "heif" to "image/heif", "svg" to "image/svg+xml",
        "pdf" to "application/pdf", "txt" to "text/plain", "csv" to "text/csv", "json" to "application/json",
        "mp4" to "video/mp4", "mov" to "video/quicktime", "mp3" to "audio/mpeg", "wav" to "audio/wav",
        "zip" to "application/zip", "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    private val MIME_TO_EXTS: Map<String, List<String>> by lazy {
        val out = HashMap<String, MutableList<String>>()
        for ((ext, mime) in EXT_TO_MIME) out.getOrPut(mime) { mutableListOf() }.add(EXT_ALIASES[ext] ?: ext)
        out
    }

    private const val GENERIC_MIME = "application/octet-stream"

    fun normalizeMimeType(mimeType: String?): String {
        if (mimeType.isNullOrEmpty()) return ""
        val base = mimeType.substringBefore(';').trim().lowercase()
        return MIME_ALIASES[base] ?: base
    }

    fun fileExtension(name: String?): String {
        if (name.isNullOrEmpty()) return ""
        val base = name.split('\\', '/').last()
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot == base.length - 1) return ""
        val ext = base.substring(dot + 1).lowercase()
        return EXT_ALIASES[ext] ?: ext
    }

    fun typeAllowed(name: String?, mimeType: String?, accept: List<String>?): Boolean {
        val tokens = accept ?: emptyList()
        if (tokens.isEmpty()) return true

        val mime = normalizeMimeType(mimeType)
        val ext = fileExtension(name)

        val mimes = HashSet<String>()
        if (mime.isNotEmpty() && mime != GENERIC_MIME) mimes.add(mime)
        EXT_TO_MIME[ext]?.let { if (ext.isNotEmpty()) mimes.add(it) }

        val exts = HashSet<String>()
        if (ext.isNotEmpty()) exts.add(ext)
        MIME_TO_EXTS[mime]?.let { exts.addAll(it) }

        for (raw in tokens) {
            val token = raw.trim().lowercase()
            if (token.isEmpty()) continue
            when {
                token.startsWith(".") -> {
                    val want = token.substring(1)
                    if (exts.contains(EXT_ALIASES[want] ?: want)) return true
                }
                token.endsWith("/*") -> {
                    val prefix = token.dropLast(1)
                    if (mimes.any { it.startsWith(prefix) }) return true
                }
                else -> if (mimes.contains(normalizeMimeType(token))) return true
            }
        }
        return false
    }

    fun sizeAllowed(sizeBytes: Any?, maxSizeBytes: Number?): Boolean {
        if (maxSizeBytes == null) return true
        if (sizeBytes !is Number) return true
        return sizeBytes.toDouble() <= maxSizeBytes.toDouble()
    }

    /** Reliable upload identity, or null when none exists (never name:size). */
    fun uploadIdentity(
        assetRef: String? = null, id: String? = null, localUri: String? = null,
        fingerprint: String? = null, name: String? = null, size: Any? = null, lastModified: Number? = null,
    ): String? = when {
        !assetRef.isNullOrEmpty() -> "ref:$assetRef"
        !id.isNullOrEmpty() -> "id:$id"
        !localUri.isNullOrEmpty() -> "uri:$localUri"
        !fingerprint.isNullOrEmpty() -> "fp:$fingerprint"
        lastModified != null -> "file:$name:$size:$lastModified"
        else -> null
    }
}
