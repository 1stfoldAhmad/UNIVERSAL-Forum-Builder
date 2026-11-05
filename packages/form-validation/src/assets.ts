/**
 * Canonical asset (file/image) constraint semantics.
 *
 * ONE definition, mirrored by the Python, PHP, Dart, Kotlin and Swift ports and
 * proven against `packages/form-conformance/fixtures/asset-upload.json`.
 *
 * Why this module exists
 * ----------------------
 * The previous rule compared an `accept` extension token against the MIME string
 * (`'.jpg'` looked for the substring `jpg` inside `image/jpeg`), so a perfectly
 * valid JPEG was rejected. Extensions must be matched against the FILENAME and
 * MIME tokens against a NORMALIZED MIME value.
 *
 * Rules (platform-neutral)
 * ------------------------
 *  - `accept` tokens are one of: exact MIME (`image/png`), MIME wildcard
 *    (`image/*`), or filename extension (`.jpg`).
 *  - MIME comparison is case-insensitive, ignores `;parameters`, and resolves
 *    well-known aliases (`image/jpg` -> `image/jpeg`).
 *  - Extension comparison is case-insensitive, uses the real filename, and
 *    resolves extension aliases (`jpg` == `jpeg`).
 *  - When the platform supplies no usable MIME (empty or the generic
 *    `application/octet-stream`), the MIME is inferred from the extension so a
 *    legitimate file is not rejected for missing browser metadata.
 *  - When the filename has no usable extension, extensions are inferred from the
 *    MIME so an extension-only `accept` still works.
 *  - Size limit is inclusive: `sizeBytes == maxSizeBytes` is allowed.
 *
 * SECURITY: client-supplied MIME/extension metadata is a UX hint, NEVER proof of
 * content. The trusted upload/storage provider remains authoritative and must
 * validate actual content; server-side validation re-checks these constraints.
 */

/** MIME aliases normalized to their canonical form. */
export const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-pdf': 'application/pdf',
  'application/acrobat': 'application/pdf',
};

/** Extension aliases normalized to a canonical extension. */
export const EXT_ALIASES: Record<string, string> = {
  jpg: 'jpeg', jpe: 'jpeg', tif: 'tiff', htm: 'html',
};

/** Well-known extension -> MIME mapping used only when MIME is missing/generic. */
export const EXT_TO_MIME: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Reverse mapping (canonical MIME -> canonical extensions). */
export const MIME_TO_EXTS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
    const canonExt = EXT_ALIASES[ext] ?? ext;
    (out[mime] ??= []).push(canonExt);
  }
  // JPEG is commonly written .jpg as well as .jpeg; both canonicalize to jpeg.
  return out;
})();

const GENERIC_MIME = 'application/octet-stream';

/** Lowercase, trim, drop `;parameters`, resolve aliases. */
export function normalizeMimeType(mimeType?: string | null): string {
  if (!mimeType) return '';
  const base = String(mimeType).split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
}

/** Canonical extension of a filename ('' when there is none). */
export function fileExtension(name?: string | null): string {
  if (!name) return '';
  const base = String(name).split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return ''; // '.gitignore' / 'trailing.'
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_ALIASES[ext] ?? ext;
}

export interface AssetLike {
  name?: string | null;
  mimeType?: string | null;
}

/**
 * True when the asset satisfies `accept`. Empty/absent `accept` allows anything.
 * Mirrored exactly by every language port.
 */
export function assetTypeAllowed(asset: AssetLike, accept?: string[] | null): boolean {
  if (!accept || accept.length === 0) return true;

  const mime = normalizeMimeType(asset.mimeType);
  const ext = fileExtension(asset.name);

  const mimes = new Set<string>();
  if (mime && mime !== GENERIC_MIME) mimes.add(mime);
  if (ext && EXT_TO_MIME[ext]) mimes.add(EXT_TO_MIME[ext]);

  const exts = new Set<string>();
  if (ext) exts.add(ext);
  for (const e of MIME_TO_EXTS[mime] ?? []) exts.add(e);

  for (const raw of accept) {
    const token = String(raw).trim().toLowerCase();
    if (!token) continue;
    if (token.startsWith('.')) {
      const want = token.slice(1);
      if (exts.has(EXT_ALIASES[want] ?? want)) return true;
    } else if (token.endsWith('/*')) {
      const prefix = token.slice(0, -1); // 'image/'
      for (const m of mimes) if (m.startsWith(prefix)) return true;
    } else {
      if (mimes.has(normalizeMimeType(token))) return true;
    }
  }
  return false;
}

/** Inclusive size limit: equal is allowed, greater is rejected. */
export function assetSizeAllowed(sizeBytes: unknown, maxSizeBytes?: number | null): boolean {
  if (maxSizeBytes === undefined || maxSizeBytes === null) return true;
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) return true;
  return sizeBytes <= maxSizeBytes;
}
