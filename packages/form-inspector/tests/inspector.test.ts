import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import { inspectRuntime, inspectIR } from '../src/index';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import type { FormIR, SubmissionExecutor } from '@vds-form/types';

const load = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', name), 'utf8'));
const irOf = (name: string): FormIR => {
  const r = compileForm(load(name));
  if (!r.ok) throw new Error('compile failed');
  return r.ir;
};

describe('inspector', () => {
  it('redacts sensitive values (password) by default', async () => {
    const doc = load('contact.vds.json');
    doc.fields.push({ id: 'secret', type: 'password', key: 'secret', label: 'Secret' });
    const r = compileForm(doc);
    if (!r.ok) throw new Error('compile');
    const c = new FormController({ ir: r.ir });
    await c.initialize();
    c.setFieldValue('secret', 'hunter2');
    const report = inspectRuntime(c);
    const secret = report.fields.find((f) => f.id === 'secret')!;
    expect(secret.value).toBe('[REDACTED]');
    expect(JSON.stringify(report)).not.toContain('hunter2');
    const unredacted = inspectRuntime(c, { redactSensitive: false });
    expect(unredacted.fields.find((f) => f.id === 'secret')!.value).toBe('hunter2');
    c.dispose();
  });

  it('reports effective state, issues, dependencies and metrics', async () => {
    const c = new FormController({ ir: irOf('customer-registration.vds.json') });
    await c.initialize();
    c.setFieldValue('customer.type', 'business');
    const report = inspectRuntime(c);
    const company = report.fields.find((f) => f.id === 'companyName')!;
    expect(company.visible).toBe(true);
    expect(company.required).toBe(true);
    expect(report.state).toBe('dirty');
    expect(report.dependencies.edges.length).toBeGreaterThan(0);
    expect(report.metrics.evaluations).toBeGreaterThan(0);
    c.dispose();
  });

  it('inspectIR exposes operation references and dependency visualization data', () => {
    const report = inspectIR(irOf('purchase-approval.vds.json'));
    expect(report.operationReferences.submission).toBe('test:purchase.create');
    expect(report.operationReferences.onSuccess).toContain('workflow:purchase.approval');
    expect(report.dependencyGraph.nodes.length).toBeGreaterThan(0);
    expect(report.dependencyGraph.evaluationOrder.length).toBeGreaterThan(0);
    expect(report.requiredCapabilities).toEqual([]);
  });

  it('omits values when includeValues=false', async () => {
    const c = new FormController({ ir: irOf('contact.vds.json') });
    await c.initialize();
    c.setFieldValue('name', 'Ada');
    const report = inspectRuntime(c, { includeValues: false });
    expect(report.fields.every((f) => f.value === undefined)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('Ada');
    c.dispose();
  });
});
