import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFormDocument, validateStructure, FORM_SCHEMA, SUPPORTED_SPEC_VERSIONS } from '../src/index';

const formsDir = join(__dirname, '..', '..', '..', 'examples', 'forms');
const fixturesDir = join(__dirname, 'fixtures');
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('vds.form 1.0.0 JSON Schema', () => {
  it('is Draft 2020-12 with a stable $id', () => {
    expect(FORM_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(FORM_SCHEMA.$id).toContain('vds-form/1.0.0');
    expect(SUPPORTED_SPEC_VERSIONS).toContain('1.0.0');
  });

  const examples = readdirSync(formsDir).filter((f) => f.endsWith('.vds.json'));
  it('has the 9 canonical example forms', () => {
    expect(examples.length).toBe(9);
  });
  for (const file of examples) {
    it(`validates example ${file}`, () => {
      const result = validateStructure(load(join(formsDir, file)));
      expect(result.diagnostics).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }

  it('rejects unsupported specVersion with FORM_VERSION_UNSUPPORTED', () => {
    const r = validateStructure(load(join(fixturesDir, 'bad-version.json')));
    expect(r.valid).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'FORM_VERSION_UNSUPPORTED')).toBe(true);
  });

  it('rejects executable-string expressions structurally', () => {
    const r = validateStructure(load(join(fixturesDir, 'bad-expr.json')));
    expect(r.valid).toBe(false);
    expect(r.diagnostics.every((d) => d.code === 'FORM_SCHEMA_INVALID')).toBe(true);
  });

  it('rejects raw URLs as operation references (no arbitrary endpoints)', () => {
    const r = validateStructure(load(join(fixturesDir, 'bad-url-ref.json')));
    expect(r.valid).toBe(false);
    expect(r.diagnostics.some((d) => d.path?.includes('providerRef'))).toBe(true);
  });

  it('rejects fields without a key', () => {
    const r = validateStructure(load(join(fixturesDir, 'bad-field.json')));
    expect(r.valid).toBe(false);
  });

  it('rejects non-objects and wrong format', () => {
    expect(validateStructure(null).valid).toBe(false);
    expect(validateStructure([]).valid).toBe(false);
    expect(validateStructure({ format: 'something.else' }).valid).toBe(false);
  });

  it('parseFormDocument handles malformed JSON and oversized input', () => {
    const bad = parseFormDocument('{not json');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics[0].code).toBe('FORM_SCHEMA_INVALID');
    const huge = parseFormDocument('x'.repeat(5_000_001));
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.diagnostics[0].code).toBe('LIMIT_EXCEEDED');
  });

  it('parseFormDocument returns typed document for valid input', () => {
    const r = parseFormDocument(readFileSync(join(formsDir, 'contact.vds.json'), 'utf8'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document.id).toBe('contact');
  });
});
