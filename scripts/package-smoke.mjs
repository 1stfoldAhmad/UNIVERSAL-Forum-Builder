#!/usr/bin/env node
/**
 * Fresh external-project smoke test against packed tarballs (no registry
 * publication). Installs the packed @vds-form packages into a temporary project
 * and exercises compile → runtime → trusted Node adapter end-to-end.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, '.release');
if (!existsSync(join(release, 'tarballs.json'))) {
  console.error('Run npm run build:packages && npm run pack:packages first.');
  process.exit(1);
}
const tarballs = JSON.parse(readFileSync(join(release, 'tarballs.json'), 'utf8'));
const project = join(tmpdir(), `vds-package-smoke-${Date.now()}`);
mkdirSync(project, { recursive: true });

const overrides = {};
for (const [name, path] of Object.entries(tarballs)) overrides[name] = `file:${path}`;
const pkg = {
  name: 'vds-package-smoke',
  private: true,
  type: 'module',
  dependencies: {
    '@vds-form/core': `file:${tarballs['@vds-form/core']}`,
    '@vds-form/execution-node': `file:${tarballs['@vds-form/execution-node']}`,
    '@vds-form/vds-contracts': `file:${tarballs['@vds-form/vds-contracts']}`,
    '@vds-form/react': `file:${tarballs['@vds-form/react']}`,
    '@vds-form/vue': `file:${tarballs['@vds-form/vue']}`,
    react: '19.3.0',
    vue: '^3.5.44',
  },
  overrides,
};
writeFileSync(join(project, 'package.json'), JSON.stringify(pkg, null, 2));
const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: project, encoding: 'utf8' });
if (install.status !== 0) {
  console.error(install.stdout); console.error(install.stderr);
  process.exit(1);
}

const form = JSON.parse(readFileSync(join(root, 'examples', 'forms', 'contact.vds.json'), 'utf8'));
writeFileSync(join(project, 'form.json'), JSON.stringify(form));
writeFileSync(join(project, 'smoke.mjs'), `
import { readFileSync } from 'node:fs';
import { compileForm, FormController } from '@vds-form/core';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import { TestOperationExecutor, succeeded, InMemoryRecordStore } from '@vds-form/vds-contracts';
import { TrustedSubmissionHandler, OperationRegistry } from '@vds-form/execution-node';
import { UniversalForm } from '@vds-form/react';
import { VUniversalForm } from '@vds-form/vue';
if (typeof UniversalForm !== 'function') throw new Error('React renderer export missing');
if (typeof VUniversalForm !== 'object' && typeof VUniversalForm !== 'function') throw new Error('Vue renderer export missing');

const doc = JSON.parse(readFileSync(new URL('./form.json', import.meta.url), 'utf8'));
const compiled = compileForm(doc);
if (!compiled.ok) throw new Error('compile failed: ' + JSON.stringify(compiled.diagnostics));

const executors = new SubmissionExecutorRegistry();
executors.register(new TestOperationExecutor('test', { 'test:contact.create': (ctx) => succeeded('test:contact.create', { id: 'c1' }, ctx) }));
const controller = new FormController({ ir: compiled.ir, executors });
await controller.initialize();
controller.setFieldValue('name', 'Ada Lovelace');
controller.setFieldValue('email', 'ada@example.com');
controller.setFieldValue('message', 'Hello from the packed-package smoke test.');
const result = await controller.submit();
if (result.status !== 'succeeded') throw new Error('runtime submit failed: ' + JSON.stringify(result));
controller.dispose();

const store = new InMemoryRecordStore();
const operations = new OperationRegistry();
operations.register('test:contact.create', (payload) => store.create('contact', payload));
const handler = new TrustedSubmissionHandler({ forms: { contact: doc }, operations });
const trusted = await handler.handle({ formId: 'contact', values: { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hello from the trusted adapter.' }, idempotencyKey: 'smoke-1', correlationId: 'smoke' }, undefined);
if (trusted.status !== 'succeeded') throw new Error('trusted submit failed: ' + JSON.stringify(trusted));
if (store.list('contact').length !== 1) throw new Error('record not persisted');
console.log('PACKAGE SMOKE PASSED');
`);
const run = spawnSync(process.execPath, ['smoke.mjs'], { cwd: project, encoding: 'utf8' });
console.log(run.stdout);
if (run.status !== 0) {
  console.error(run.stderr);
  rmSync(project, { recursive: true, force: true });
  process.exit(1);
}
rmSync(project, { recursive: true, force: true });
