/**
 * Canonical asset accept/size conformance — shared fixture, all languages.
 * Fixture: packages/form-conformance/fixtures/asset-upload.json
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetTypeAllowed, assetSizeAllowed, fileExtension, normalizeMimeType } from '../src/assets';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'form-conformance', 'fixtures', 'asset-upload.json'), 'utf8'),
) as { cases: { id: string; name: string; mimeType: string; accept: string[]; sizeBytes: number; maxSizeBytes?: number; expect: { typeAllowed: boolean; sizeAllowed: boolean } }[] };

describe('asset constraint conformance (shared fixture)', () => {
  it(`matches all ${fixture.cases.length} shared cases`, () => {
    const failures: string[] = [];
    for (const c of fixture.cases) {
      const typeAllowed = assetTypeAllowed({ name: c.name, mimeType: c.mimeType }, c.accept);
      const sizeAllowed = assetSizeAllowed(c.sizeBytes, c.maxSizeBytes);
      if (typeAllowed !== c.expect.typeAllowed) {
        failures.push(`${c.id}: typeAllowed expected ${c.expect.typeAllowed}, got ${typeAllowed}`);
      }
      if (sizeAllowed !== c.expect.sizeAllowed) {
        failures.push(`${c.id}: sizeAllowed expected ${c.expect.sizeAllowed}, got ${sizeAllowed}`);
      }
    }
    expect(failures, failures.join(' | ')).toEqual([]);
  });
});

describe('asset helpers', () => {
  it('normalizes MIME case, parameters and aliases', () => {
    expect(normalizeMimeType('IMAGE/JPEG')).toBe('image/jpeg');
    expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeMimeType('image/jpg')).toBe('image/jpeg');
    expect(normalizeMimeType('image/x-png')).toBe('image/png');
    expect(normalizeMimeType(undefined)).toBe('');
  });

  it('extracts a canonical extension from the filename, not the MIME', () => {
    expect(fileExtension('photo.JPG')).toBe('jpeg');
    expect(fileExtension('a/b/report.pdf')).toBe('pdf');
    expect(fileExtension('C:\\uploads\\x.tiff')).toBe('tiff');
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileExtension('trailing.')).toBe('');
    expect(fileExtension('noext')).toBe('');
  });

  it('regression: .jpg must match image/jpeg (the original defect)', () => {
    expect(assetTypeAllowed({ name: 'p.jpg', mimeType: 'image/jpeg' }, ['.jpg'])).toBe(true);
    // and must NOT be satisfied by an unrelated MIME that merely contains 'jpg'
    expect(assetTypeAllowed({ name: 'p.png', mimeType: 'image/png' }, ['.jpg'])).toBe(false);
  });
});
