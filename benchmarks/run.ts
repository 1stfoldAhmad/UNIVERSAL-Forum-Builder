/**
 * Performance benchmarks for the VDS Universal Form Builder core.
 * Run: npm run bench   (tsx benchmarks/run.ts)
 *
 * Measures compile / expression / validation / runtime / payload throughput
 * with a warmup phase. Results are indicative single-run numbers on the host
 * machine, not guarantees; they are printed as a table and written to
 * benchmarks/RESULTS.md for the implementation ledger.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  compileForm, evaluate, validateValues, computeEffectiveState,
  buildSubmissionPayload, FormController, type FormIR,
} from '@vds-form/core';
import type { Expr, FormDocument } from '@vds-form/types';

const here = dirname(fileURLToPath(import.meta.url));
const formsDir = join(here, '..', 'examples', 'forms');
const load = (name: string): FormDocument => JSON.parse(readFileSync(join(formsDir, name), 'utf8'));

interface BenchResult { name: string; iterations: number; totalMs: number; opsPerSec: number; avgUs: number }
const results: BenchResult[] = [];

function bench(name: string, iterations: number, fn: () => void, warmup = Math.min(500, iterations)): void {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - start;
  results.push({
    name, iterations, totalMs: Math.round(totalMs * 100) / 100,
    opsPerSec: Math.round((iterations / totalMs) * 1000),
    avgUs: Math.round((totalMs / iterations) * 1000 * 100) / 100,
  });
}

const examples = ['contact.vds.json', 'customer-registration.vds.json', 'invoice.vds.json', 'job-application.vds.json', 'kyc-documents.vds.json'];
const docs = examples.map(load);
const irs: FormIR[] = docs.map((d) => {
  const r = compileForm(d);
  if (!r.ok) throw new Error(`compile failed: ${JSON.stringify(r.diagnostics)}`);
  return r.ir;
});

// 1. Compile throughput (all five example forms per iteration).
bench('compile (5 example forms)', 2000, () => { for (const d of docs) compileForm(d); });

// 2. Expression evaluation: invoice total formula (mul + sum + round + add).
const totalFormula = irs[2].formulas.find((f) => f.id === 'total')!.expr;
const invoiceValues = { items: [{ description: 'Widget', qty: 3, price: 10, lineTotal: 30 }, { description: 'Gadget', qty: 1, price: 5, lineTotal: 5 }], subtotal: 35, taxRate: 15, taxAmount: 5.25, total: 40.25 };
bench('evaluate invoice total formula', 100000, () => { evaluate(totalFormula, { values: invoiceValues }); });

// 3. Expression evaluation: a deep-ish arithmetic AST.
let arith: Expr = { ref: 'field:x' };
for (let i = 0; i < 20; i++) arith = { op: 'add', args: [arith, { op: 'mul', args: [{ const: 2 }, { const: 3 }] }] };
bench('evaluate 20-level arithmetic AST', 100000, () => { evaluate(arith, { values: { x: 1 } }); });

// 4. Validation throughput (customer-registration, submit phase).
const custIr = irs[1];
const custValues = { customer: { name: 'Grace Hopper', email: 'grace@example.com', type: 'business', companyName: 'Navy Labs', taxId: '123', age: 30, consent: true } };
const custState = computeEffectiveState(custIr, custValues).state;
bench('validate customer-registration (submit)', 20000, () => { validateValues(custIr, custValues, custState, { phase: 'submit' }); });

// 5. Effective-state computation (conditions).
bench('computeEffectiveState (customer)', 50000, () => { computeEffectiveState(custIr, custValues); });

// 6. Payload build (invoice, with repeater + computed).
const invIr = irs[2];
const invState = computeEffectiveState(invIr, invoiceValues).state;
bench('buildSubmissionPayload (invoice)', 50000, () => { buildSubmissionPayload(invIr, invoiceValues, invState, invIr.submission!); });

// 7. Runtime field-update + recompute (headless controller).
const controller = new FormController({ ir: invIr });
await controller.initialize();
bench('runtime setFieldValue + recompute (invoice)', 5000, () => {
  controller.setFieldValue('items.0.qty', 4);
  controller.setFieldValue('items.0.qty', 3);
});
controller.dispose();

// ---- report ----
const lines: string[] = [];
lines.push('# Benchmark results');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()} · Node ${process.version} · single-run indicative numbers (warmup + measured iterations).`);
lines.push('');
lines.push('| Benchmark | Iterations | Total (ms) | Ops/sec | Avg (µs/op) |');
lines.push('|---|---:|---:|---:|---:|');
for (const r of results) {
  lines.push(`| ${r.name} | ${r.iterations.toLocaleString()} | ${r.totalMs} | ${r.opsPerSec.toLocaleString()} | ${r.avgUs} |`);
}
lines.push('');
lines.push('These figures characterize the headless core (no UI rendering). Renderer paint performance is environment-specific and out of scope for this harness.');
const report = lines.join('\n');
console.log(report);
writeFileSync(join(here, 'RESULTS.md'), report + '\n');
console.log(`\nWrote benchmarks/RESULTS.md`);
