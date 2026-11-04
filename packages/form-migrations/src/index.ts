/**
 * @vds-form/migrations — versioned, diagnostic migration framework.
 * Never silently reinterprets old documents: every step is explicit, lossy steps
 * require opt-in, and the original document is always preserved as a backup.
 */
import type { Diagnostic, FormDocument } from '@vds-form/types';
import { validateStructure, CURRENT_SPEC_VERSION } from '@vds-form/spec';

export interface MigrationStep {
  fromVersion: string;
  toVersion: string;
  description: string;
  /** Pure transform. Must not mutate the input. */
  migrate: (doc: Record<string, unknown>) => { doc: Record<string, unknown>; lossy?: boolean; notes?: string[] };
}

export interface MigrationResult {
  ok: boolean;
  document?: FormDocument;
  backup: unknown;
  applied: Array<{ from: string; to: string; description: string; lossy: boolean; notes: string[] }>;
  diagnostics: Diagnostic[];
}

export class MigrationRegistry {
  private steps: MigrationStep[] = [];

  register(step: MigrationStep): void {
    if (this.steps.some((s) => s.fromVersion === step.fromVersion && s.toVersion === step.toVersion)) {
      throw new Error(`MIGRATION_DUPLICATE: ${step.fromVersion} → ${step.toVersion}`);
    }
    this.steps.push(step);
  }

  /** Find a migration path (BFS over registered steps). */
  findPath(from: string, to: string): MigrationStep[] | null {
    if (from === to) return [];
    const queue: Array<{ version: string; path: MigrationStep[] }> = [{ version: from, path: [] }];
    const seen = new Set([from]);
    while (queue.length) {
      const { version, path } = queue.shift()!;
      for (const step of this.steps.filter((s) => s.fromVersion === version)) {
        if (step.toVersion === to) return [...path, step];
        if (!seen.has(step.toVersion)) {
          seen.add(step.toVersion);
          queue.push({ version: step.toVersion, path: [...path, step] });
        }
      }
    }
    return null;
  }

  migrate(input: unknown, targetVersion: string = CURRENT_SPEC_VERSION, opts: { allowLossy?: boolean } = {}): MigrationResult {
    const backup = structuredClone(input);
    const diagnostics: Diagnostic[] = [];
    const applied: MigrationResult['applied'] = [];
    if (typeof input !== 'object' || input === null) {
      return { ok: false, backup, applied, diagnostics: [{ code: 'FORM_SCHEMA_INVALID', severity: 'error', message: 'Migration input must be an object.' }] };
    }
    let doc = structuredClone(input) as Record<string, unknown>;
    const fromVersion = typeof doc.specVersion === 'string' ? doc.specVersion : 'unknown';
    const path = this.findPath(fromVersion, targetVersion);
    if (!path) {
      return {
        ok: false, backup, applied,
        diagnostics: [{ code: 'FORM_VERSION_UNSUPPORTED', severity: 'error', message: `No migration path from ${fromVersion} to ${targetVersion}.`, suggestion: 'Register the required migration steps or upgrade manually.' }],
      };
    }
    for (const step of path) {
      const result = step.migrate(doc);
      if (result.lossy && !opts.allowLossy) {
        return {
          ok: false, backup, applied,
          diagnostics: [{ code: 'FORM_VERSION_UNSUPPORTED', severity: 'error', message: `Migration ${step.fromVersion} → ${step.toVersion} is lossy (${(result.notes ?? []).join('; ')}). Re-run with allowLossy to accept.`, suggestion: 'Review the notes, keep the backup, then opt in.' }],
        };
      }
      doc = result.doc;
      applied.push({ from: step.fromVersion, to: step.toVersion, description: step.description, lossy: result.lossy === true, notes: result.notes ?? [] });
    }
    const validation = validateStructure(doc);
    if (!validation.valid) {
      return { ok: false, backup, applied, diagnostics: validation.diagnostics };
    }
    return { ok: true, document: doc as unknown as FormDocument, backup, applied, diagnostics };
  }
}

/**
 * Built-in migration: pre-release draft 0.9.0 → 1.0.0.
 * 0.9.0 is the documented pre-release draft of this standard (used by early fixtures):
 *  - fields used `name` instead of `key`
 *  - submission lived at `submit.operation` instead of `submission.operationRef`
 *  - `title` instead of `metadata.name`
 * Unknown top-level members are dropped (lossy, reported).
 */
export function createDefaultMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register({
    fromVersion: '0.9.0',
    toVersion: '1.0.0',
    description: 'Upgrade pre-release draft documents to vds.form 1.0.0.',
    migrate: (input) => {
      const doc = structuredClone(input);
      const notes: string[] = [];
      let lossy = false;
      doc.format = 'vds.form';
      doc.specVersion = '1.0.0';
      if (typeof doc.title === 'string' && !doc.metadata) {
        doc.metadata = { name: doc.title };
        delete doc.title;
      }
      const renameKeys = (fields: unknown): unknown => {
        if (!Array.isArray(fields)) return fields;
        return fields.map((f) => {
          if (typeof f !== 'object' || f === null) return f;
          const field = { ...(f as Record<string, unknown>) };
          if (typeof field.name === 'string' && field.key === undefined) {
            field.key = field.name;
            delete field.name;
          }
          if (Array.isArray(field.children)) field.children = renameKeys(field.children);
          return field;
        });
      };
      doc.fields = renameKeys(doc.fields);
      const submit = doc.submit as { operation?: string } | undefined;
      if (submit?.operation && !doc.submission) {
        doc.submission = { operationRef: submit.operation };
        delete doc.submit;
      }
      const allowed = new Set(['format', 'specVersion', 'id', 'metadata', 'model', 'fields', 'layout', 'logic', 'validation', 'dataSources', 'submission', 'persistence', 'security', 'localization', 'capabilities', 'extensions']);
      for (const key of Object.keys(doc)) {
        if (!allowed.has(key)) {
          delete doc[key];
          notes.push(`Dropped unknown member "${key}".`);
          lossy = true;
        }
      }
      return { doc, lossy, notes };
    },
  });
  return registry;
}

/** Compare two document versions structurally (field-level diff). */
export function compareVersions(a: FormDocument, b: FormDocument) {
  const fieldsA = new Map(a.fields.map((f) => [f.id, f]));
  const fieldsB = new Map(b.fields.map((f) => [f.id, f]));
  const added = [...fieldsB.keys()].filter((id) => !fieldsA.has(id));
  const removed = [...fieldsA.keys()].filter((id) => !fieldsB.has(id));
  const changed = [...fieldsA.keys()].filter((id) => fieldsB.has(id) && JSON.stringify(fieldsA.get(id)) !== JSON.stringify(fieldsB.get(id)));
  return {
    fromVersion: a.metadata.version ?? '0.0.0',
    toVersion: b.metadata.version ?? '0.0.0',
    added, removed, changed,
    submissionChanged: JSON.stringify(a.submission ?? null) !== JSON.stringify(b.submission ?? null),
    logicChanged: JSON.stringify(a.logic ?? null) !== JSON.stringify(b.logic ?? null),
  };
}
