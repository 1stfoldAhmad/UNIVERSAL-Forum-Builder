import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli, type CliIO } from '../src/index';

const formsDir = join(__dirname, '..', '..', '..', 'examples', 'forms');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readFile: (p) => readFileSync(p, 'utf8'),
  };
  return { io, out, err, stdout: () => out.join('\n'), stderr: () => err.join('\n') };
}

describe('vds-form CLI', () => {
  it('prints usage with no args (exit 2) and help (exit 0)', async () => {
    const c1 = capture();
    expect(await runCli([], c1.io)).toBe(2);
    expect(c1.stdout()).toContain('Usage:');
    const c2 = capture();
    expect(await runCli(['--help'], c2.io)).toBe(0);
  });

  it('validate accepts a canonical form', async () => {
    const c = capture();
    const code = await runCli(['validate', join(formsDir, 'contact.vds.json')], c.io);
    expect(code).toBe(0);
    expect(JSON.parse(c.stdout()).formId).toBe('contact');
  });

  it('validate rejects a bad document with diagnostics (exit 1)', async () => {
    const c = capture();
    const code = await runCli(['validate', join(__dirname, '..', '..', '..', 'packages', 'form-spec', 'tests', 'fixtures', 'bad-version.json')], c.io);
    expect(code).toBe(1);
    expect(JSON.parse(c.stderr()).ok).toBe(false);
  });

  it('compile prints a summary and --json prints the full IR', async () => {
    const c = capture();
    expect(await runCli(['compile', join(formsDir, 'invoice.vds.json')], c.io)).toBe(0);
    const summary = JSON.parse(c.stdout());
    expect(summary.formId).toBe('invoice');
    expect(summary.fieldCount).toBeGreaterThan(0);
    expect(summary.fingerprint).toBeTruthy();

    const cj = capture();
    expect(await runCli(['compile', join(formsDir, 'invoice.vds.json'), '--json'], cj.io)).toBe(0);
    const ir = JSON.parse(cj.stdout());
    expect(ir.irVersion).toBeTruthy();
    expect(Array.isArray(ir.fields)).toBe(true);
    expect(ir.dependencies.order.length).toBeGreaterThan(0);
  });

  it('compile fails on a dependency cycle (exit 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-cli-'));
    const doc = { format: 'vds.form', specVersion: '1.0.0', id: 'cyc', metadata: { name: 'Cyc', version: '1.0.0' }, fields: [{ id: 'a', type: 'computed', key: 'a', label: 'A', computed: true }, { id: 'b', type: 'computed', key: 'b', label: 'B', computed: true }], logic: { formulas: [{ id: 'fa', target: 'a', expr: { ref: 'field:b' } }, { id: 'fb', target: 'b', expr: { ref: 'field:a' } }] }, submission: { operationRef: 'test:save' } };
    const p = join(dir, 'cycle.vds.json');
    writeFileSync(p, JSON.stringify(doc));
    const c = capture();
    expect(await runCli(['compile', p], c.io)).toBe(1);
    expect(c.stderr()).toContain('DEPENDENCY_CYCLE_DETECTED');
  });

  it('inspect prints dependency graph and operation references', async () => {
    const c = capture();
    expect(await runCli(['inspect', join(formsDir, 'customer-registration.vds.json')], c.io)).toBe(0);
    const info = JSON.parse(c.stdout());
    expect(info.operationReferences.submission).toBe('test:customer.create');
    expect(info.operationReferences.asyncValidation.some((r: { operationRef: string }) => r.operationRef === 'test:customer.emailUnique')).toBe(true);
    expect(info.dependencyGraph.edges.length).toBeGreaterThan(0);
  });

  it('migrate upgrades a 0.9.0 draft document to 1.0.0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-cli-'));
    const old = { format: 'vds.form', specVersion: '0.9.0', id: 'legacy', metadata: { name: 'Legacy', version: '1.0.0' }, fields: [{ id: 'name', type: 'text', name: 'name', label: 'Name' }], submit: { operation: 'test:save' } };
    const p = join(dir, 'old.vds.json');
    writeFileSync(p, JSON.stringify(old));
    const c = capture();
    expect(await runCli(['migrate', p, '--to', '1.0.0'], c.io)).toBe(0);
    const result = JSON.parse(c.stdout());
    expect(result.ok).toBe(true);
    expect(result.document.specVersion).toBe('1.0.0');
    expect(result.applied.length).toBeGreaterThan(0);
  });

  it('capabilities prints the generic field manifest', async () => {
    const c = capture();
    expect(await runCli(['capabilities'], c.io)).toBe(0);
    const manifest = JSON.parse(c.stdout());
    expect(manifest.target).toBe('generic');
    expect(manifest.fieldTypes.text).toBeTruthy();
    expect(manifest.fieldTypes.repeater).toBeTruthy();
  });

  it('conformance runs green (exit 0) and reports counts', async () => {
    const c = capture();
    expect(await runCli(['conformance'], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/\d+\/\d+ passed, 0 failed/);
    const cj = capture();
    expect(await runCli(['conformance', '--json'], cj.io)).toBe(0);
    const report = JSON.parse(cj.stdout());
    expect(report.failed).toBe(0);
    expect(report.total).toBeGreaterThan(50);
  });

  it('unknown command exits 2', async () => {
    const c = capture();
    expect(await runCli(['bogus'], c.io)).toBe(2);
    expect(c.stderr()).toContain('Unknown command');
  });

  it('compile negotiates against a capability manifest that lacks a required type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vds-cli-'));
    const manifest = { target: 'limited', contractVersion: '1.0.0', fieldTypes: { text: { supported: true } }, features: {} };
    const mp = join(dir, 'manifest.json');
    writeFileSync(mp, JSON.stringify(manifest));
    const c = capture();
    // invoice uses repeater/currency/computed which the limited manifest lacks.
    const code = await runCli(['compile', join(formsDir, 'invoice.vds.json'), '--capabilities', mp], c.io);
    expect(code).toBe(1);
    expect(c.stderr()).toContain('CAPABILITY');
  });
});
