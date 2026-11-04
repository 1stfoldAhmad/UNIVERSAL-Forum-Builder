import { describe, expect, it } from 'vitest';
import { createDefaultMigrationRegistry, MigrationRegistry, compareVersions } from '../src/index';
import { compileForm } from '@vds-form/compiler';
import type { FormDocument } from '@vds-form/types';

const draft09 = {
  format: 'vds.form.draft',
  specVersion: '0.9.0',
  id: 'legacy-contact',
  title: 'Legacy Contact',
  fields: [
    { id: 'name', type: 'text', name: 'name', label: 'Name', required: true },
    { id: 'email', type: 'email', name: 'email', label: 'Email', required: true },
  ],
  submit: { operation: 'test:contact.create' },
};

describe('migration framework', () => {
  it('migrates a 0.9.0 draft to a compilable 1.0.0 document', () => {
    const registry = createDefaultMigrationRegistry();
    const r = registry.migrate(draft09);
    expect(r.ok).toBe(true);
    expect(r.applied.length).toBe(1);
    expect(r.document!.specVersion).toBe('1.0.0');
    expect(r.document!.fields[0].key).toBe('name');
    expect(r.document!.submission!.operationRef).toBe('test:contact.create');
    const compiled = compileForm(r.document);
    expect(compiled.ok).toBe(true);
    // Backup preserved untouched.
    expect((r.backup as typeof draft09).specVersion).toBe('0.9.0');
    expect((r.backup as typeof draft09).fields[0].name).toBe('name');
  });

  it('rejects lossy migrations unless explicitly allowed', () => {
    const registry = createDefaultMigrationRegistry();
    const withJunk = { ...draft09, legacyExtra: { something: true } };
    const rejected = registry.migrate(withJunk);
    expect(rejected.ok).toBe(false);
    expect(rejected.diagnostics[0].message).toContain('lossy');
    const accepted = registry.migrate(withJunk, '1.0.0', { allowLossy: true });
    expect(accepted.ok).toBe(true);
    expect(accepted.applied[0].lossy).toBe(true);
    expect(accepted.applied[0].notes.some((n) => n.includes('legacyExtra'))).toBe(true);
  });

  it('rejects documents with no migration path', () => {
    const registry = createDefaultMigrationRegistry();
    const r = registry.migrate({ ...draft09, specVersion: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe('FORM_VERSION_UNSUPPORTED');
  });

  it('no-op migration for current version validates structure', () => {
    const registry = createDefaultMigrationRegistry();
    const current = registry.migrate(draft09).document!;
    const r = registry.migrate(current);
    expect(r.ok).toBe(true);
    expect(r.applied.length).toBe(0);
  });

  it('chains multi-step migrations deterministically', () => {
    const registry = new MigrationRegistry();
    registry.register({ fromVersion: '1.0.0', toVersion: '1.1.0', description: 'step A', migrate: (d) => ({ doc: { ...d, specVersion: '1.1.0' } }) });
    registry.register({ fromVersion: '1.1.0', toVersion: '2.0.0', description: 'step B', migrate: (d) => ({ doc: { ...d, specVersion: '2.0.0' } }) });
    const path = registry.findPath('1.0.0', '2.0.0');
    expect(path!.map((s) => s.description)).toEqual(['step A', 'step B']);
    expect(registry.findPath('2.0.0', '1.0.0')).toBeNull(); // no silent downgrades
  });

  it('compareVersions reports field and logic diffs', () => {
    const a: FormDocument = {
      format: 'vds.form', specVersion: '1.0.0', id: 'x', metadata: { name: 'X', version: '1.0.0' },
      fields: [{ id: 'f1', type: 'text', key: 'f1' }, { id: 'f2', type: 'text', key: 'f2' }],
    };
    const b: FormDocument = {
      ...a, metadata: { name: 'X', version: '1.1.0' },
      fields: [{ id: 'f1', type: 'text', key: 'f1', required: true }, { id: 'f3', type: 'email', key: 'f3' }],
    };
    const diff = compareVersions(a, b);
    expect(diff.added).toEqual(['f3']);
    expect(diff.removed).toEqual(['f2']);
    expect(diff.changed).toEqual(['f1']);
  });
});
