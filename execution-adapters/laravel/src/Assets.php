<?php
declare(strict_types=1);

namespace VdsForm;

/**
 * Canonical asset (file/image) constraint semantics — PHP port.
 *
 * Mirrors packages/form-validation/src/assets.ts exactly and is proven against
 * the shared fixture packages/form-conformance/fixtures/asset-upload.json.
 *
 * Extensions match the FILENAME; MIME tokens match a NORMALIZED MIME; either may
 * be inferred from the other. The size limit is inclusive.
 *
 * SECURITY: client metadata is a hint, never proof of content. The trusted
 * upload/storage provider remains authoritative.
 */
final class Assets
{
    public const MIME_ALIASES = [
        'image/jpg' => 'image/jpeg',
        'image/pjpeg' => 'image/jpeg',
        'image/x-png' => 'image/png',
        'application/x-pdf' => 'application/pdf',
        'application/acrobat' => 'application/pdf',
    ];

    public const EXT_ALIASES = ['jpg' => 'jpeg', 'jpe' => 'jpeg', 'tif' => 'tiff', 'htm' => 'html'];

    public const EXT_TO_MIME = [
        'jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp',
        'bmp' => 'image/bmp', 'heic' => 'image/heic', 'heif' => 'image/heif', 'svg' => 'image/svg+xml',
        'pdf' => 'application/pdf', 'txt' => 'text/plain', 'csv' => 'text/csv', 'json' => 'application/json',
        'mp4' => 'video/mp4', 'mov' => 'video/quicktime', 'mp3' => 'audio/mpeg', 'wav' => 'audio/wav',
        'zip' => 'application/zip', 'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls' => 'application/vnd.ms-excel',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];

    private const GENERIC_MIME = 'application/octet-stream';

    public static function normalizeMimeType(?string $mimeType): string
    {
        if ($mimeType === null || $mimeType === '') return '';
        $base = strtolower(trim(explode(';', $mimeType)[0]));
        return self::MIME_ALIASES[$base] ?? $base;
    }

    public static function fileExtension(?string $name): string
    {
        if ($name === null || $name === '') return '';
        $parts = preg_split('/[\\\\\/]/', $name);
        $base = $parts === false ? $name : end($parts);
        $dot = strrpos($base, '.');
        if ($dot === false || $dot <= 0 || $dot === strlen($base) - 1) return '';
        $ext = strtolower(substr($base, $dot + 1));
        return self::EXT_ALIASES[$ext] ?? $ext;
    }

    /** @return array<string, list<string>> */
    private static function mimeToExts(): array
    {
        static $map = null;
        if ($map === null) {
            $map = [];
            foreach (self::EXT_TO_MIME as $ext => $mime) {
                $canon = self::EXT_ALIASES[$ext] ?? $ext;
                $map[$mime][] = $canon;
            }
        }
        return $map;
    }

    public static function typeAllowed(array $asset, ?array $accept): bool
    {
        $tokens = $accept ?? [];
        if (count($tokens) === 0) return true;

        $mime = self::normalizeMimeType(isset($asset['mimeType']) ? (string)$asset['mimeType'] : null);
        $ext = self::fileExtension(isset($asset['name']) ? (string)$asset['name'] : null);

        $mimes = [];
        if ($mime !== '' && $mime !== self::GENERIC_MIME) $mimes[$mime] = true;
        if ($ext !== '' && isset(self::EXT_TO_MIME[$ext])) $mimes[self::EXT_TO_MIME[$ext]] = true;

        $exts = [];
        if ($ext !== '') $exts[$ext] = true;
        foreach (self::mimeToExts()[$mime] ?? [] as $e) $exts[$e] = true;

        foreach ($tokens as $raw) {
            $token = strtolower(trim((string)$raw));
            if ($token === '') continue;
            if (str_starts_with($token, '.')) {
                $want = substr($token, 1);
                if (isset($exts[self::EXT_ALIASES[$want] ?? $want])) return true;
            } elseif (str_ends_with($token, '/*')) {
                $prefix = substr($token, 0, -1);
                foreach (array_keys($mimes) as $m) if (str_starts_with($m, $prefix)) return true;
            } elseif (isset($mimes[self::normalizeMimeType($token)])) {
                return true;
            }
        }
        return false;
    }

    public static function sizeAllowed(mixed $sizeBytes, int|float|null $maxSizeBytes): bool
    {
        if ($maxSizeBytes === null) return true;
        if (!is_int($sizeBytes) && !is_float($sizeBytes)) return true;
        return $sizeBytes <= $maxSizeBytes;
    }
}
