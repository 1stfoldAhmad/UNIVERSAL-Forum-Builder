import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm, canonicalStringify, fnv1aHex } from '../src/index';
import { defaultFieldRegistry } from '@vds-form/fields';
import type { FormDocument, RendererCapabilityManifest } from '@vds-form/types';

const load = (name: string): FormDocument =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));

const codes = (r: { ok: false; diagnostics: Array<{ code: string }> }) => r.diagnostics.map((d) => d.code);

describe('compiler: valid documents', () => {
  const examples = ['contact.vds.json', 'customer-registration.vds.json', 'invoice.vds.json',
    'job-application.vds.json', 'business-address.vds.json', 'kyc-documents.vds.json',
    'purchase-approval.vds.json', 'field-survey.vds.json', 'nested-profile.vds.json'];
  for (const name of examples) {
    it(`compiles ${name} to FormIR`, () => {
      const r = compileForm(load(name));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.ir.irVersion).toBe('1.0.0');
        expect(r.ir.fields.length).toBeGreaterThan(0);
        expect(r.ir.fingerprint).toMatch(/^[0-9a-f]{8}$/);
        expect(r.ir.dependencies.order.length).toBeGreaterThan(0);
      }
    });
  }

  it('is deterministic: same input → identical IR and fingerprint', () => {
    const a = compileForm(load('invoice.vds.json'));
    const b = compileForm(JSON.parse(JSON.stringify(load('invoice.vds.json'))));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.ir.fingerprint).toBe(b.ir.fingerprint);
      expect(canonicalStringify(a.ir)).toBe(canonicalStringify(b.ir));
    }
  });

  it('normalizes invoice: computed targets become readonly, row formulas detected', () => {
    const r = compileForm(load('invoice.vds.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lineTotal = r.ir.fields.find((f) => f.key === 'items[].lineTotal')!;
    expect(lineTotal.computed).toBe(true);
    expect(lineTotal.readonly).toBe(true);
    expect(lineTotal.repeaterId).toBe('items');
    const rowFormula = r.ir.formulas.find((f) => f.id === 'lineTotal')!;
    expect(rowFormula.rowScoped).toBe(true);
    // dependency order: qty/price before lineTotal formula before subtotal formula
    const order = r.ir.dependencies.order;
    expect(order.indexOf('f:items[].qty')).toBeLessThan(order.indexOf('F:lineTotal'));
    expect(order.indexOf('F:lineTotal')).toBeLessThan(order.indexOf('F:subtotal'));
    expect(order.indexOf('F:subtotal')).toBeLessThan(order.indexOf('F:total'));
  });

  it('derives capabilities from field types and layout', () => {
    const r = compileForm(load('kyc-documents.vds.json'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ir.requiredCapabilities).toContain('file-upload');
    const j = compileForm(load('job-application.vds.json'));
    if (j.ok) expect(j.ir.requiredCapabilities).toContain('multi-step');
    const inv = compileForm(load('invoice.vds.json'));
    if (inv.ok) expect(inv.ir.requiredCapabilities).toContain('repeaters');
  });

  it('auto-places unlisted fields and builds a default layout', () => {
    const r = compileForm(load('contact.vds.json'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ir.layout.fieldRefs).toEqual(['name', 'email', 'message']);
  });
});

describe('compiler: diagnostics', () => {
  const base = () => load('contact.vds.json');

  it('rejects duplicate field ids and keys', () => {
    const doc = base();
    doc.fields.push({ ...doc.fields[0] });
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codes(r)).toContain('FIELD_ID_DUPLICATE');
      expect(codes(r)).toContain('FIELD_KEY_DUPLICATE');
    }
  });

  it('rejects unknown field types', () => {
    const doc = base();
    doc.fields[0].type = 'hologram';
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain('FIELD_TYPE_UNKNOWN');
  });

  it('rejects invalid expression references and unknown operators', () => {
    const doc = base();
    doc.logic = {
      conditions: [{ id: 'c1', when: { op: 'eq', args: [{ ref: 'field:nope' }, { const: 1 }] }, effects: [{ fieldId: 'name', set: { required: true } }] }],
      formulas: [{ id: 'f1', target: 'message', expr: { op: 'exec', args: [{ const: 'rm -rf' }] } }],
    };
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codes(r)).toContain('EXPRESSION_REFERENCE_INVALID');
      expect(codes(r)).toContain('EXPRESSION_PARSE_FAILED');
    }
  });

  it('rejects conditions targeting unknown fields', () => {
    const doc = base();
    doc.logic = { conditions: [{ id: 'c1', when: { const: true }, effects: [{ fieldId: 'ghost', set: { visible: true } }] }] };
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain('FIELD_REFERENCE_INVALID');
  });

  it('detects dependency cycles', () => {
    const doc = base();
    doc.fields.push(
      { id: 'a', type: 'integer', key: 'a', label: 'A', computed: true },
      { id: 'b', type: 'integer', key: 'b', label: 'B', computed: true },
    );
    doc.logic = { formulas: [
      { id: 'fa', target: 'a', expr: { op: 'add', args: [{ ref: 'field:b' }, { const: 1 }] } },
      { id: 'fb', target: 'b', expr: { op: 'add', args: [{ ref: 'field:a' }, { const: 1 }] } },
    ] };
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codes(r)).toContain('DEPENDENCY_CYCLE_DETECTED');
      expect(r.diagnostics[0].reference).toContain('→');
    }
  });

  it('detects self-referencing formula cycles', () => {
    const doc = base();
    doc.fields.push({ id: 'a', type: 'integer', key: 'a', label: 'A' });
    doc.logic = { formulas: [{ id: 'fa', target: 'a', expr: { op: 'add', args: [{ ref: 'field:a' }, { const: 1 }] } }] };
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain('DEPENDENCY_CYCLE_DETECTED');
  });

  it('rejects item refs outside row scope and bad repeater child keys', () => {
    const doc = load('invoice.vds.json');
    doc.logic!.formulas![0].expr = { op: 'mul', args: [{ ref: 'item:nonexistent' }, { const: 2 }] };
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain('EXPRESSION_REFERENCE_INVALID');

    const doc2 = load('invoice.vds.json');
    doc2.fields.find((f) => f.id === 'items')!.children![0].key = 'wrong.description';
    const r2 = compileForm(doc2);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(codes(r2)).toContain('FIELD_KEY_INVALID');
  });

  it('rejects nested repeaters explicitly (documented 1.0.0 limitation)', () => {
    const doc = load('invoice.vds.json');
    const items = doc.fields.find((f) => f.id === 'items')!;
    items.children!.push({ id: 'inner', type: 'repeater', key: 'items[].inner', label: 'Inner', children: [
      { id: 'x', type: 'text', key: 'items[].inner[].x', label: 'X' },
    ] });
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.message.includes('Nested repeaters'))).toBe(true);
  });

  it('resolves builder references strictly when registries are provided', () => {
    const doc = load('business-address.vds.json');
    const r = compileForm(doc, { knownDataSourceOperations: ['test:geo.countries'], knownSubmissionOperations: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codes(r)).toContain('DATA_SOURCE_UNRESOLVED');
      expect(codes(r)).toContain('SUBMISSION_OPERATION_UNRESOLVED');
    }
    const ok = compileForm(doc, {
      knownDataSourceOperations: ['test:geo.countries', 'test:geo.cities'],
      knownSubmissionOperations: ['test:address.save'],
    });
    expect(ok.ok).toBe(true);
  });

  it('validates submission input mapping paths', () => {
    const doc = load('customer-registration.vds.json');
    doc.submission!.inputMapping = { name: 'customer.doesNotExist' };
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain('SUBMISSION_MAPPING_INVALID');
  });

  it('negotiates platform capabilities with fallbacks and hard errors', () => {
    const manifest: RendererCapabilityManifest = {
      target: 'test-minimal', contractVersion: '1.0.0',
      fieldTypes: Object.fromEntries(
        defaultFieldRegistry.list()
          .filter((c) => !['file', 'image', 'signature'].includes(c.type))
          .map((c) => [c.type, c.capability]),
      ),
      features: { repeaters: true, multiStep: true },
    };
    const r = compileForm(load('kyc-documents.vds.json'), { target: manifest });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain('PLATFORM_CAPABILITY_UNSUPPORTED');

    const withFallback: RendererCapabilityManifest = {
      ...manifest,
      fieldTypes: {
        ...manifest.fieldTypes,
        file: { ...defaultFieldRegistry.get('file')!.capability, fallbackStrategy: 'file-picker' },
        image: { ...defaultFieldRegistry.get('image')!.capability, fallbackStrategy: 'file-picker' },
      },
      features: { ...manifest.features, filePicker: true },
    };
    const r2 = compileForm(load('kyc-documents.vds.json'), { target: withFallback });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.warnings.some((w) => w.message.includes('fallback'))).toBe(true);
  });

  it('rejects invalid layout references', () => {
    const doc = base();
    doc.layout = { type: 'section', fieldRefs: ['ghost'] };
    const r = compileForm(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain('LAYOUT_REFERENCE_INVALID');
  });

  it('produces source maps for diagnostics', () => {
    const r = compileForm(load('invoice.vds.json'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ir.sourceMap['f:items[].qty']).toMatch(/^\/fields\/\d+\/children\/\d+$/);
      expect(r.ir.sourceMap['F:total']).toBe('/logic/formulas/3');
    }
  });
});

describe('canonical hashing', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(fnv1aHex('abc')).toBe(fnv1aHex('abc'));
    expect(fnv1aHex('abc')).not.toBe(fnv1aHex('abd'));
  });
});
