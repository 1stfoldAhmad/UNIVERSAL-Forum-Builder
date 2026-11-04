import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runConformance, runExpressionConformance, runFormConformance,
  EXPRESSION_FIXTURES, FORM_FIXTURES, CONFORMANCE_SPEC_VERSION,
} from '../src/index';
import { compileForm } from '@vds-form/compiler';
import { REACT_CAPABILITY_MANIFEST } from '@vds-form/react';

describe('conformance suite', () => {
  it('every expression fixture passes against the TS evaluator', () => {
    const results = runExpressionConformance();
    const failures = results.filter((r) => !r.passed);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(50);
  });

  it('every compiler/validation/payload fixture passes', () => {
    const results = runFormConformance();
    const failures = results.filter((r) => !r.passed);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });

  it('aggregate report is fully green', () => {
    const report = runConformance();
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.total);
    expect(report.specVersion).toBe(CONFORMANCE_SPEC_VERSION);
  });

  it('fixtures are portable JSON (no TS-only constructs)', () => {
    // Re-parse from disk to guarantee the fixtures are pure data other languages can load.
    const expr = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'expressions.json'), 'utf8'));
    const forms = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'forms.json'), 'utf8'));
    expect(expr.suite).toBe('vds.expr/1');
    expect(forms.suite).toBe('vds.form/1');
    expect(expr.cases.length).toBe(EXPRESSION_FIXTURES.cases.length);
    expect(forms.compilation.length).toBe(FORM_FIXTURES.compilation.length);
  });

  it('all nine canonical example forms compile under the React capability manifest', () => {
    const formsDir = join(__dirname, '..', '..', '..', 'examples', 'forms');
    const names = ['contact', 'customer-registration', 'invoice', 'kyc-documents', 'job-application', 'business-address', 'nested-profile', 'field-survey', 'purchase-approval'];
    for (const name of names) {
      const doc = JSON.parse(readFileSync(join(formsDir, `${name}.vds.json`), 'utf8'));
      const r = compileForm(doc, { target: REACT_CAPABILITY_MANIFEST });
      expect(r.ok, `${name}: ${JSON.stringify(!r.ok ? r.diagnostics : [])}`).toBe(true);
    }
  });
});
