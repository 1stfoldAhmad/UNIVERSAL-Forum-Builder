/**
 * Generate compiled FormIR fixtures for the Python adapter tests.
 * The IR is the deterministic cross-language contract: the TS compiler produces
 * it once; the Python trusted handler re-validates against the very same IR.
 * Run from repo root: npx tsx execution-adapters/django/scripts/gen_ir_fixtures.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileForm } from '@vds-form/compiler';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const outDir = join(here, '..', 'tests', 'fixtures', 'ir');
mkdirSync(outDir, { recursive: true });

const forms = JSON.parse(readFileSync(join(root, 'packages', 'form-conformance', 'fixtures', 'forms.json'), 'utf8'));
let count = 0;
for (const section of ['validation', 'payload'] as const) {
  for (const c of forms[section]) {
    const r = compileForm(c.document);
    if (!r.ok) throw new Error(`${c.id}: ${JSON.stringify(r.diagnostics)}`);
    writeFileSync(join(outDir, `${section}-${c.id}.ir.json`), JSON.stringify(r.ir, null, 2));
    count++;
  }
}
for (const name of ['contact', 'customer-registration', 'invoice']) {
  const doc = JSON.parse(readFileSync(join(root, 'examples', 'forms', `${name}.vds.json`), 'utf8'));
  const r = compileForm(doc);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.diagnostics)}`);
  writeFileSync(join(outDir, `${name}.ir.json`), JSON.stringify(r.ir, null, 2));
  count++;
}
console.log(`Wrote ${count} IR fixtures to ${outDir}`);
