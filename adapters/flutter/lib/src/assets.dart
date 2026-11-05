/// Canonical asset (file/image) constraint semantics — Dart port.
///
/// Mirrors packages/form-validation/src/assets.ts and is proven against the
/// shared fixture packages/form-conformance/fixtures/asset-upload.json.
///
/// Extensions match the FILENAME; MIME tokens match a NORMALIZED MIME; either
/// may be inferred from the other. The size limit is inclusive.
///
/// SECURITY: client metadata is a hint, never proof of content. The trusted
/// upload/storage provider remains authoritative.
library;

const Map<String, String> mimeAliases = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-pdf': 'application/pdf',
  'application/acrobat': 'application/pdf',
};

const Map<String, String> extAliases = {'jpg': 'jpeg', 'jpe': 'jpeg', 'tif': 'tiff', 'htm': 'html'};

const Map<String, String> extToMime = {
  'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
  'bmp': 'image/bmp', 'heic': 'image/heic', 'heif': 'image/heif', 'svg': 'image/svg+xml',
  'pdf': 'application/pdf', 'txt': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
  'mp4': 'video/mp4', 'mov': 'video/quicktime', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
  'zip': 'application/zip', 'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const String _genericMime = 'application/octet-stream';

Map<String, List<String>> get mimeToExts {
  final out = <String, List<String>>{};
  extToMime.forEach((ext, mime) {
    (out[mime] ??= <String>[]).add(extAliases[ext] ?? ext);
  });
  return out;
}

String normalizeMimeType(String? mimeType) {
  if (mimeType == null || mimeType.isEmpty) return '';
  final base = mimeType.split(';').first.trim().toLowerCase();
  return mimeAliases[base] ?? base;
}

String fileExtension(String? name) {
  if (name == null || name.isEmpty) return '';
  final base = name.split(RegExp(r'[\\/]')).last;
  final dot = base.lastIndexOf('.');
  if (dot <= 0 || dot == base.length - 1) return '';
  final ext = base.substring(dot + 1).toLowerCase();
  return extAliases[ext] ?? ext;
}

bool assetTypeAllowed({String? name, String? mimeType, List<String>? accept}) {
  final tokens = accept ?? const <String>[];
  if (tokens.isEmpty) return true;

  final mime = normalizeMimeType(mimeType);
  final ext = fileExtension(name);

  final mimes = <String>{};
  if (mime.isNotEmpty && mime != _genericMime) mimes.add(mime);
  if (ext.isNotEmpty && extToMime.containsKey(ext)) mimes.add(extToMime[ext]!);

  final exts = <String>{};
  if (ext.isNotEmpty) exts.add(ext);
  for (final e in (mimeToExts[mime] ?? const <String>[])) {
    exts.add(e);
  }

  for (final raw in tokens) {
    final token = raw.trim().toLowerCase();
    if (token.isEmpty) continue;
    if (token.startsWith('.')) {
      final want = token.substring(1);
      if (exts.contains(extAliases[want] ?? want)) return true;
    } else if (token.endsWith('/*')) {
      final prefix = token.substring(0, token.length - 1);
      if (mimes.any((m) => m.startsWith(prefix))) return true;
    } else if (mimes.contains(normalizeMimeType(token))) {
      return true;
    }
  }
  return false;
}

bool assetSizeAllowed(Object? sizeBytes, num? maxSizeBytes) {
  if (maxSizeBytes == null) return true;
  if (sizeBytes is! num) return true;
  return sizeBytes <= maxSizeBytes;
}

/// Reliable identity for upload de-duplication, or null when none exists.
/// Deliberately NOT name:size — that collides for distinct files.
String? uploadIdentity({String? assetRef, String? id, String? localUri, String? fingerprint, String? name, Object? size, num? lastModified}) {
  if (assetRef != null && assetRef.isNotEmpty) return 'ref:$assetRef';
  if (id != null && id.isNotEmpty) return 'id:$id';
  if (localUri != null && localUri.isNotEmpty) return 'uri:$localUri';
  if (fingerprint != null && fingerprint.isNotEmpty) return 'fp:$fingerprint';
  if (lastModified != null) return 'file:$name:$size:$lastModified';
  return null;
}
