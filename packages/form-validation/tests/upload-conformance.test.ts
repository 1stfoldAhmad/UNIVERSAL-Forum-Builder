import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assetTypeAllowed } from '../src/index';

type Fixture = { cases: { id: string; name: string; mimeType: string; accept: string[]; allowed: boolean }[]; sizeBoundaries: { sizeBytes: number; maxSizeBytes: number; allowed: boolean }[] };
const fixtures = JSON.parse(readFileSync(resolve(__dirname, '../../form-conformance/fixtures/uploads.json'), 'utf8')) as Fixture;

describe('shared upload accept fixtures', () => {
  it.each(fixtures.cases)('$id', ({ name, mimeType, accept, allowed }) => {
    expect(assetTypeAllowed(accept, name, mimeType)).toBe(allowed);
  });
  it.each(fixtures.sizeBoundaries)('size boundary $sizeBytes <= $maxSizeBytes is $allowed', ({ sizeBytes, maxSizeBytes, allowed }) => {
    expect(sizeBytes <= maxSizeBytes).toBe(allowed);
  });
});
