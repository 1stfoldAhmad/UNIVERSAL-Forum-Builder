/**
 * @vds-form/runtime — framework-independent form controller.
 * No React/Angular/Vue/React Native imports. Owns values, effective state,
 * dependency-aware recomputation, validation, drafts, offline queue and the
 * real submission lifecycle (delegated to registered executors only).
 */
import type {
  AuthContext, DataSourceProvider, DataSourceStatus, DraftStorageAdapter, Expr,
  FieldOption, FormIR, FormSnapshot, FormState, FormValues, NormalizedField,
  OfflineQueueAdapter, QueuedSubmissionRecord, RbacEvaluator, SubmissionContext,
  SubmissionExecutor, SubmissionResult, UploadProvider, ValidationIssue, ValidationResult,
} from '@vds-form/types';
import {
  evaluate, evaluateBoolean, deleteIn, getPath, setIn, deepEqual,
} from '@vds-form/expressions';
import { defaultFieldRegistry, type FieldRegistry } from '@vds-form/fields';
import {
  AsyncValidator, expandFieldInstances, localize, validateValues,
  type EffectiveFieldState,
} from '@vds-form/validation';
import {
  DataSourceCache, DataSourceProviderRegistry, evaluateParams, mapOptions,
} from '@vds-form/data-sources';
import {
  draftScopeKey, loadDraftChecked, makeDraftEnvelope,
} from '@vds-form/persistence';
import {
  SubmissionExecutorRegistry, buildSubmissionPayload, configError,
  makeIdempotencyKey, resolveExecutor,
} from '@vds-form/submission';

export interface RuntimeOptions {
  ir: FormIR;
  initialValues?: FormValues;
  executors?: SubmissionExecutorRegistry;
  dataProviders?: DataSourceProviderRegistry;
  drafts?: DraftStorageAdapter;
  offlineQueue?: OfflineQueueAdapter;
  uploadProvider?: UploadProvider;
  rbac?: RbacEvaluator;
  auth?: AuthContext;
  locale?: string;
  /** Approved non-secret context for expressions (today, locale facts…). */
  context?: Record<string, unknown>;
  isOnline?: () => boolean;
  now?: () => Date;
  newId?: () => string;
  fields?: FieldRegistry;
  deviceId?: string;
}

const TRANSITIONS: Record<FormState, FormState[]> = {
  uninitialized: ['compiling', 'disposed'],
  compiling: ['ready', 'restoring-draft', 'disposed'],
  'restoring-draft': ['ready', 'disposed'],
  ready: ['dirty', 'validating', 'submitting', 'restoring-draft', 'suspended', 'disposed'],
  dirty: ['validating', 'submitting', 'ready', 'suspended', 'disposed'],
  validating: ['invalid', 'ready', 'dirty', 'submitting', 'disposed'],
  invalid: ['dirty', 'validating', 'submitting', 'ready', 'suspended', 'disposed'],
  submitting: ['submission-succeeded', 'submission-failed', 'offline-queued', 'invalid', 'dirty', 'disposed'],
  'submission-failed': ['dirty', 'submitting', 'ready', 'validating', 'suspended', 'disposed'],
  'submission-succeeded': ['dirty', 'ready', 'submitting', 'suspended', 'disposed'],
  'offline-queued': ['dirty', 'submitting', 'ready', 'suspended', 'disposed'],
  suspended: ['ready', 'dirty', 'disposed'],
  disposed: [],
};

export type FormListener = (snapshot: FormSnapshot) => void;

let idCounter = 0;
const defaultNewId = (): string => {
  idCounter += 1;
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `${Date.now().toString(36)}-${idCounter}`;
  return rand;
};

export class FormController {
  readonly ir: FormIR;
  private opts: RuntimeOptions;
  private registry: FieldRegistry;
  private state: FormState = 'uninitialized';
  private values: FormValues = {};
  private initialValues: FormValues = {};
  private initialRowIds: Record<string, string[]> = {};
  private rowIds: Record<string, string[]> = {};
  private touched: Record<string, boolean> = {};
  private focusedPath: string | null = null;
  private syncIssues: ValidationIssue[] = [];
  private asyncIssues = new Map<string, ValidationIssue>();
  private asyncStatus: FormSnapshot['asyncValidation'] = {};
  private effective: EffectiveFieldState = { visibility: {}, required: {}, disabled: {}, readonly: {} };
  private dsStatus: Record<string, DataSourceStatus> = {};
  private dsGen = new Map<string, number>();
  private dsControllers = new Map<string, AbortController>();
  private dsCache = new DataSourceCache();
  private submission: FormSnapshot['submission'] = { status: 'idle' };
  private draft: FormSnapshot['draft'] = { status: 'none' };
  private pendingConflict: { values: FormValues } | null = null;
  private diagnostics: FormSnapshot['diagnostics'] = [];
  private metrics = { evaluations: 0, validations: 0, submissions: 0 };
  private listeners = new Set<FormListener>();
  private fieldListeners = new Map<string, Set<(slice: unknown) => void>>();
  private fieldSliceCache = new Map<string, string>();
  private snapshotCache: FormSnapshot | null = null;
  private asyncValidator: AsyncValidator;
  private submitLock = false;
  private submitController: AbortController | null = null;
  private newId: () => string;
  private now: () => Date;
  private locale: string;
  private dependents = new Map<string, Set<string>>();
  private fieldByTemplate = new Map<string, NormalizedField>();
  private repeaters: NormalizedField[];

  constructor(options: RuntimeOptions) {
    this.opts = options;
    this.ir = options.ir;
    this.registry = options.fields ?? defaultFieldRegistry;
    this.newId = options.newId ?? defaultNewId;
    this.now = options.now ?? (() => new Date());
    this.locale = options.locale ?? this.ir.localization.defaultLocale;
    this.repeaters = this.ir.fields.filter((f) => f.type === 'repeater');
    for (const f of this.ir.fields) this.fieldByTemplate.set(f.key, f);
    for (const e of this.ir.dependencies.edges) {
      if (!this.dependents.has(e.from)) this.dependents.set(e.from, new Set());
      this.dependents.get(e.from)!.add(e.to);
    }
    this.asyncValidator = new AsyncValidator(
      this.ir.asyncRules,
      (ref) => this.opts.dataProviders?.forRef(ref),
      this.locale,
    );
  }

  /* ---------------- lifecycle ---------------- */

  async initialize(): Promise<void> {
    if (this.state !== 'uninitialized') return;
    this.transition('compiling');
    this.values = this.buildDefaults(this.opts.initialValues ?? {});
    this.initRowIds(this.values);
    this.initialRowIds = JSON.parse(JSON.stringify(this.rowIds));
    this.recomputeEffective();
    this.recomputeFormulas(new Set(this.ir.formulas.map((f) => `F:${f.id}`)));
    this.initialValues = structuredClone(this.values);
    for (const s of this.ir.dataSources) this.dsStatus[s.id] = { status: 'idle' };

    if (this.ir.persistence.drafts?.enabled && this.opts.drafts) {
      this.transition('restoring-draft');
      const scopeKey = draftScopeKey(this.ir.persistence, this.opts.auth, this.opts.deviceId);
      const loaded = await loadDraftChecked(this.opts.drafts, this.ir.formId, this.ir.formVersion, scopeKey);
      if (loaded.status === 'restored' && loaded.envelope) {
        this.values = this.buildDefaults(loaded.envelope.values);
        this.initRowIds(this.values);
        this.recomputeEffective();
        this.recomputeFormulas(new Set(this.ir.formulas.map((f) => `F:${f.id}`)));
        this.draft = { status: 'restored', savedAt: loaded.envelope.savedAt };
      } else if (loaded.status === 'conflict' && loaded.envelope) {
        this.draft = { status: 'conflict', message: loaded.reason };
        this.pendingConflict = { values: loaded.envelope.values };
      }
    }
    this.transition('ready');
    this.notify();
    void this.loadAllSources();
  }

  private buildDefaults(initial: FormValues): FormValues {
    let v: FormValues = structuredClone(initial);
    for (const f of this.ir.fields) {
      if (f.repeaterId) continue; // row defaults applied per row
      if (f.type === 'repeater') {
        if (getPath(v, f.key) === undefined) v = setIn(v, f.key, []);
        continue;
      }
      if (f.type === 'group') {
        if (getPath(v, f.key) === undefined) v = setIn(v, f.key, {});
        continue;
      }
      if (getPath(v, f.key) === undefined && f.defaultValue !== undefined) {
        v = setIn(v, f.key, f.defaultValue);
      }
    }
    return v;
  }

  private rowDefaults(repeater: NormalizedField): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    const children = this.ir.fields.filter((f) => f.repeaterId === repeater.id && f.type !== 'repeater');
    for (const c of children) {
      const rel = c.key.slice(repeater.key.length + 3);
      const contract = this.registry.get(c.type);
      const def = c.defaultValue ?? contract?.defaultValue;
      if (c.type === 'group') {
        // nested group defaults handled by child fields
        continue;
      }
      if (def !== undefined) {
        const parts = rel.split('.');
        let target = row;
        for (let i = 0; i < parts.length - 1; i++) {
          target[parts[i]] = (target[parts[i]] as Record<string, unknown>) ?? {};
          target = target[parts[i]] as Record<string, unknown>;
        }
        target[parts[parts.length - 1]] = def;
      }
    }
    return row;
  }

  private initRowIds(values: FormValues): void {
    this.rowIds = {};
    for (const r of this.repeaters) {
      const rows = getPath(values, r.key);
      const count = Array.isArray(rows) ? rows.length : 0;
      this.rowIds[r.id] = Array.from({ length: count }, () => this.newId());
    }
  }

  private transition(to: FormState): boolean {
    if (!TRANSITIONS[this.state].includes(to)) {
      this.diagnostics.push({ code: 'INVALID_TRANSITION', message: `Illegal state transition ${this.state} → ${to}.`, path: undefined });
      return false;
    }
    this.state = to;
    this.snapshotCache = null;
    return true;
  }

  getState(): FormState { return this.state; }

  /* ---------------- values ---------------- */

  getValues(): FormValues { return structuredClone(this.values); }

  setValues(values: Partial<FormValues>): void {
    this.assertActive();
    let v = this.values;
    for (const [k, val] of Object.entries(values)) v = setIn(v, k, val);
    this.values = v;
    this.markDirty();
    this.recomputeAfterChange(Object.keys(values));
    this.notify();
  }

  getFieldValue(path: string): unknown { return getPath(this.values, path) ?? null; }

  setFieldValue(path: string, value: unknown, opts: { touch?: boolean } = {}): void {
    this.assertActive();
    const field = this.fieldForConcretePath(path);
    if (field?.readonly || this.effective.readonly[field.id]) {
      this.diagnostics.push({ code: 'READONLY_WRITE', message: `Field "${path}" is read-only; write ignored.`, path });
      this.notify();
      return;
    }
    const contract = field ? this.registry.get(field.type) : undefined;
    const normalized = contract?.normalize ? contract.normalize(value) : value;
    this.values = setIn(this.values, path, normalized);
    if (opts.touch !== false) this.touched[path] = true;
    this.markDirty();
    this.recomputeAfterChange([path]);
    this.scheduleAsyncFor(path);
    this.notify();
  }

  focus(path: string): void { this.focusedPath = path; this.notify(); }
  blur(path: string): void {
    this.touched[path] = true;
    if (this.focusedPath === path) this.focusedPath = null;
    this.notify();
  }
  isTouched(path: string): boolean { return this.touched[path] === true; }

  private markDirty(): void {
    if (['ready', 'invalid', 'submission-failed', 'submission-succeeded', 'offline-queued'].includes(this.state)) {
      this.transition('dirty');
    }
  }

  private fieldForConcretePath(path: string): NormalizedField | undefined {
    const direct = this.fieldByTemplate.get(path);
    if (direct) return direct;
    for (const r of this.repeaters) {
      if (path.startsWith(`${r.key}.`)) {
        const rest = path.slice(r.key.length + 1);
        const m = /^\d+\.(.+)$/.exec(rest);
        if (m) return this.fieldByTemplate.get(`${r.key}[].${m[1]}`);
      }
    }
    // nested object leaf
    for (const [template, f] of this.fieldByTemplate) {
      if (!template.includes('[]') && (path === template || path.startsWith(`${template}.`))) return f;
    }
    return undefined;
  }

  private concreteToTemplate(path: string): string {
    for (const r of this.repeaters) {
      if (path.startsWith(`${r.key}.`)) {
        const rest = path.slice(r.key.length + 1);
        return `${r.key}[]${rest.replace(/^\d+/, '')}`;
      }
    }
    return path;
  }

  /* ---------------- dependency-aware recomputation ---------------- */

  private dirtyNodesFrom(changedPaths: string[], structuralRepeaters: string[] = []): Set<string> {
    const seeds = new Set<string>();
    for (const p of changedPaths) {
      const t = this.concreteToTemplate(p);
      if (this.dependents.has(`f:${t}`) || this.ir.fields.some((f) => f.key === t)) seeds.add(`f:${t}`);
      const root = t.split('.')[0].split('[]')[0];
      seeds.add(`f:${root}`);
    }
    for (const repKey of structuralRepeaters) {
      seeds.add(`f:${repKey}`);
      for (const f of this.ir.fields) {
        if (f.key.startsWith(`${repKey}[]`)) seeds.add(`f:${f.key}`);
      }
    }
    const dirty = new Set<string>();
    const queue = [...seeds];
    while (queue.length) {
      const n = queue.shift()!;
      for (const dep of this.dependents.get(n) ?? []) {
        if (!dirty.has(dep)) { dirty.add(dep); queue.push(dep); }
      }
    }
    return dirty;
  }

  private recomputeAfterChange(changedPaths: string[], structuralRepeaters: string[] = []): void {
    const dirty = this.dirtyNodesFrom(changedPaths, structuralRepeaters);
    this.recomputeEffective();
    this.recomputeFormulas(dirty);
    for (const s of this.ir.dataSources) {
      if (dirty.has(`s:${s.id}`)) void this.loadSource(s.id);
    }
    this.revalidate(changedPaths, structuralRepeaters);
  }

  private recomputeEffective(): void {
    const eff: EffectiveFieldState = { visibility: {}, required: {}, disabled: {}, readonly: {} };
    for (const f of this.ir.fields) {
      eff.visibility[f.id] = !f.hidden;
      eff.required[f.id] = f.required;
      eff.disabled[f.id] = f.disabled;
      eff.readonly[f.id] = f.readonly;
    }
    const scope = { values: this.values, context: this.opts.context, sources: this.sourceValues() };
    for (const c of this.ir.conditions) {
      const r = evaluateBoolean(c.when, scope);
      this.metrics.evaluations += 1;
      if (!r.ok) {
        this.pushDiag('CONDITION_EVAL_FAILED', `${c.id}: ${r.message}`);
        continue;
      }
      if (r.value === true) {
        for (const effItem of c.effects) {
          const s = effItem.set;
          if (s.visible !== undefined) eff.visibility[effItem.fieldId] = s.visible;
          if (s.required !== undefined) eff.required[effItem.fieldId] = s.required;
          if (s.disabled !== undefined) eff.disabled[effItem.fieldId] = s.disabled;
          if (s.readonly !== undefined) eff.readonly[effItem.fieldId] = s.readonly;
        }
      }
    }
    this.effective = eff;
  }

  private recomputeFormulas(dirty: Set<string>): void {
    const scopeBase = { values: this.values, context: this.opts.context, sources: this.sourceValues() };
    for (const f of this.ir.formulas) {
      if (!dirty.has(`F:${f.id}`)) continue;
      if (f.rowScoped) {
        const repKey = f.target.slice(0, f.target.indexOf('[]'));
        const rel = f.target.slice(repKey.length + 3);
        const rows = getPath(this.values, repKey);
        const count = Array.isArray(rows) ? rows.length : 0;
        for (let i = 0; i < count; i++) {
          const r = evaluate(f.expr, { ...scopeBase, values: this.values, rowPrefix: `${repKey}.${i}`, rowIndex: i, parentPrefix: '' });
          this.metrics.evaluations += 1;
          if (r.ok) this.values = setIn(this.values, `${repKey}.${i}.${rel}`, r.value);
          else this.pushDiag('FORMULA_EVAL_FAILED', `${f.id}[${i}]: ${r.message}`, `${repKey}.${i}.${rel}`);
        }
      } else {
        const r = evaluate(f.expr, { ...scopeBase, values: this.values });
        this.metrics.evaluations += 1;
        if (r.ok) this.values = setIn(this.values, f.target, r.value);
        else this.pushDiag('FORMULA_EVAL_FAILED', `${f.id}: ${r.message}`, f.target);
      }
    }
  }

  private revalidate(changedPaths: string[], structuralRepeaters: string[] = []): void {
    const prefixes = new Set<string>();
    for (const p of changedPaths) prefixes.add(p.split('.')[0]);
    for (const r of structuralRepeaters) prefixes.add(r);
    const result = validateValues(this.ir, this.values, this.effective, {
      locale: this.locale, phase: 'change',
      paths: prefixes.size ? [...prefixes] : undefined,
      context: this.opts.context, sources: this.sourceValues(), fields: this.registry,
    });
    this.metrics.validations += 1;
    const under = (issuePath: string) => [...prefixes].some((p) => issuePath === p || issuePath.startsWith(`${p}.`) || issuePath.startsWith(`${p}[`));
    this.syncIssues = [
      ...this.syncIssues.filter((i) => i.source === 'cross' ? false : !under(i.path)),
      ...result.issues.filter((i) => i.source !== 'cross'),
      ...result.issues.filter((i) => i.source === 'cross'),
    ];
    // dedupe cross rules
    const seen = new Set<string>();
    this.syncIssues = this.syncIssues.filter((i) => {
      const k = `${i.source}|${i.code}|${i.path}|${i.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.snapshotCache = null;
  }

  private scheduleAsyncFor(path: string): void {
    for (const rule of this.ir.asyncRules) {
      if (rule.path === path || path.startsWith(`${rule.path}.`)) {
        this.asyncValidator.schedule(
          rule, getPath(this.values, rule.path),
          (outcome) => {
            if (!outcome.valid) {
              this.asyncIssues.set(outcome.ruleId, {
                code: outcome.code ?? 'ASYNC_INVALID', message: outcome.message ?? 'Invalid value.',
                path: outcome.path, severity: 'error', source: 'async',
              });
            } else {
              this.asyncIssues.delete(outcome.ruleId);
            }
            this.snapshotCache = null;
            this.notify();
          },
          (status) => {
            this.asyncStatus[rule.id] = { status: status === 'idle' ? 'idle' : status };
            this.snapshotCache = null;
            this.notify();
          },
        );
      }
    }
  }

  /* ---------------- data sources ---------------- */

  private sourceValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, s] of Object.entries(this.dsStatus)) out[id] = s.options ?? null;
    return out;
  }

  async loadAllSources(): Promise<void> {
    await Promise.all(this.ir.dataSources.map((s) => this.loadSource(s.id)));
  }

  async loadSource(sourceId: string): Promise<void> {
    const def = this.ir.dataSources.find((s) => s.id === sourceId);
    if (!def || this.state === 'disposed') return;
    const { params, error } = evaluateParams(def, { values: this.values, context: this.opts.context });
    if (error) {
      this.dsStatus[sourceId] = { status: 'error', error: { code: 'PARAMS_EVAL_FAILED', message: error } };
      this.notify();
      return;
    }
    // Dependent sources with null params stay idle until dependencies resolve.
    if (Object.values(params).some((v) => v === null) && Object.keys(def.params ?? {}).length) {
      this.dsStatus[sourceId] = { status: 'idle' };
      this.notify();
      return;
    }
    const provider = this.opts.dataProviders?.forRef(def.providerRef);
    if (!provider) {
      this.dsStatus[sourceId] = { status: 'error', error: { code: 'DATA_PROVIDER_NOT_REGISTERED', message: `No provider registered for "${def.providerRef}".` } };
      this.notify();
      return;
    }
    const cacheKey = this.dsCache.key(sourceId, params);
    const cached = this.dsCache.get(cacheKey, def.cache?.ttlMs ?? 0, this.now().getTime());
    if (cached) {
      this.applySourceResponse(sourceId, cached.items);
      return;
    }
    const gen = (this.dsGen.get(sourceId) ?? 0) + 1;
    this.dsGen.set(sourceId, gen);
    this.dsControllers.get(sourceId)?.abort();
    const controller = new AbortController();
    this.dsControllers.set(sourceId, controller);
    this.dsStatus[sourceId] = { status: 'loading' };
    this.notify();
    try {
      const res = await provider.query({ providerRef: def.providerRef, params, signal: controller.signal });
      if (this.dsGen.get(sourceId) !== gen || this.state === 'disposed') return; // stale
      this.dsCache.set(cacheKey, res, cacheKey, this.now().getTime());
      this.applySourceResponse(sourceId, res.items);
    } catch (e) {
      if (this.dsGen.get(sourceId) !== gen || this.state === 'disposed') return;
      this.dsStatus[sourceId] = { status: 'error', error: { code: 'DATA_SOURCE_FETCH_FAILED', message: (e as Error).message } };
      this.notify();
    } finally {
      this.dsControllers.delete(sourceId);
    }
  }

  private applySourceResponse(sourceId: string, items: unknown[]): void {
    const bound = this.ir.fields.filter((f) => f.optionSourceId === sourceId);
    const valueKey = bound[0]?.optionValueKey ?? 'value';
    const labelKey = bound[0]?.optionLabelKey ?? 'label';
    this.dsStatus[sourceId] = { status: 'ready', options: mapOptions(items, valueKey, labelKey) };
    this.snapshotCache = null;
    this.notify();
  }

  getOptions(fieldId: string): FieldOption[] {
    const f = this.ir.fields.find((x) => x.id === fieldId);
    if (!f) return [];
    if (f.options) return f.options;
    if (f.optionSourceId) return this.dsStatus[f.optionSourceId]?.options ?? [];
    return [];
  }

  /* ---------------- repeaters (stable row identity) ---------------- */

  getRowIds(repeaterId: string): string[] { return [...(this.rowIds[repeaterId] ?? [])]; }

  addRepeaterItem(repeaterId: string, initial?: Record<string, unknown>): string | null {
    this.assertActive();
    const rep = this.repeaters.find((r) => r.id === repeaterId);
    if (!rep) return null;
    const rows = (getPath(this.values, rep.key) as unknown[]) ?? [];
    const max = rep.validation.maxItems;
    if (max !== undefined && rows.length >= max) {
      this.pushDiag('REPEATER_MAX', `Repeater "${repeaterId}" reached maxItems (${max}).`);
      this.notify();
      return null;
    }
    const rowId = this.newId();
    const row = { ...this.rowDefaults(rep), ...(initial ?? {}) };
    this.values = setIn(this.values, `${rep.key}.${rows.length}`, row);
    this.rowIds[repeaterId] = [...(this.rowIds[repeaterId] ?? []), rowId];
    this.markDirty();
    this.recomputeAfterChange([`${rep.key}.${rows.length}`], [rep.key]);
    this.notify();
    return rowId;
  }

  removeRepeaterItem(repeaterId: string, rowId: string): boolean {
    this.assertActive();
    const rep = this.repeaters.find((r) => r.id === repeaterId);
    const ids = this.rowIds[repeaterId] ?? [];
    const index = ids.indexOf(rowId);
    if (!rep || index === -1) return false;
    this.values = deleteIn(this.values, `${rep.key}.${index}`);
    this.rowIds[repeaterId] = ids.filter((_, i) => i !== index);
    this.remapRowPaths(rep.key, (i) => (i < index ? i : i > index ? i - 1 : null));
    this.markDirty();
    this.recomputeAfterChange([rep.key], [rep.key]);
    this.notify();
    return true;
  }

  moveRepeaterItem(repeaterId: string, fromIndex: number, toIndex: number): boolean {
    this.assertActive();
    const rep = this.repeaters.find((r) => r.id === repeaterId);
    const ids = this.rowIds[repeaterId] ?? [];
    if (!rep || fromIndex < 0 || toIndex < 0 || fromIndex >= ids.length || toIndex >= ids.length || fromIndex === toIndex) return false;
    const rows = [...((getPath(this.values, rep.key) as unknown[]) ?? [])];
    const [moved] = rows.splice(fromIndex, 1);
    rows.splice(toIndex, 0, moved);
    const newIds = [...ids];
    const [movedId] = newIds.splice(fromIndex, 1);
    newIds.splice(toIndex, 0, movedId);
    this.values = setIn(this.values, rep.key, rows);
    this.rowIds[repeaterId] = newIds;
    this.remapRowPaths(rep.key, (i) => {
      if (i === fromIndex) return toIndex;
      if (fromIndex < toIndex) return i > fromIndex && i <= toIndex ? i - 1 : i;
      return i >= toIndex && i < fromIndex ? i + 1 : i;
    });
    this.markDirty();
    this.recomputeAfterChange([rep.key], [rep.key]);
    this.notify();
    return true;
  }

  /** Keep touched/focus state attached to the stable row, not the array index. */
  private remapRowPaths(repKey: string, map: (index: number) => number | null): void {
    const remap = (path: string): string | null => {
      if (!path.startsWith(`${repKey}.`)) return path;
      const m = new RegExp(`^${repKey}\\.(\\d+)(.*)$`).exec(path);
      if (!m) return path;
      const next = map(Number(m[1]));
      return next === null ? null : `${repKey}.${next}${m[2]}`;
    };
    const newTouched: Record<string, boolean> = {};
    for (const [p, t] of Object.entries(this.touched)) {
      const np = remap(p);
      if (np !== null) newTouched[np] = t;
    }
    this.touched = newTouched;
    if (this.focusedPath) this.focusedPath = remap(this.focusedPath);
  }

  /* ---------------- validation ---------------- */

  async validate(): Promise<ValidationResult> {
    this.assertActive();
    this.transition('validating');
    await this.asyncValidator.settle();
    const result = validateValues(this.ir, this.values, this.effective, {
      locale: this.locale, phase: 'submit', context: this.opts.context,
      sources: this.sourceValues(), fields: this.registry,
    });
    this.metrics.validations += 1;
    this.syncIssues = result.issues;
    const issues = [...result.issues, ...this.asyncIssues.values()];
    const valid = !issues.some((i) => i.severity === 'error');
    this.transition(valid ? (this.isDirty() ? 'dirty' : 'ready') : 'invalid');
    this.snapshotCache = null;
    this.notify();
    return { valid, issues };
  }

  /* ---------------- drafts ---------------- */

  async saveDraft(): Promise<void> {
    if (!this.opts.drafts || !this.ir.persistence.drafts?.enabled || this.state === 'disposed') return;
    const scopeKey = draftScopeKey(this.ir.persistence, this.opts.auth, this.opts.deviceId);
    this.draft = { status: 'saving' };
    this.notify();
    try {
      const envelope = makeDraftEnvelope(
        this.ir.formId, this.ir.formVersion, this.ir.specVersion, scopeKey,
        this.values, this.ir.persistence.drafts.ttlSeconds, this.now(),
      );
      await this.opts.drafts.save(envelope);
      this.draft = { status: 'saved', savedAt: envelope.savedAt };
    } catch (e) {
      this.draft = { status: 'error', message: (e as Error).message };
    }
    this.notify();
  }

  async clearDraft(): Promise<void> {
    if (!this.opts.drafts) return;
    const scopeKey = draftScopeKey(this.ir.persistence, this.opts.auth, this.opts.deviceId);
    await this.opts.drafts.clear(this.ir.formId, scopeKey);
    this.draft = { status: 'none' };
    this.notify();
  }

  /** Explicit resolution of a version-conflicted draft (never auto-applied). */
  async resolveDraftConflict(choice: 'apply' | 'discard'): Promise<void> {
    if (this.draft.status !== 'conflict' || !this.pendingConflict) return;
    if (choice === 'apply') {
      this.values = this.buildDefaults(this.pendingConflict.values);
      this.initRowIds(this.values);
      this.recomputeEffective();
      this.recomputeFormulas(new Set(this.ir.formulas.map((f) => `F:${f.id}`)));
      this.revalidate([]);
      this.draft = { status: 'restored' };
    } else {
      await this.clearDraft();
    }
    this.pendingConflict = null;
    this.notify();
  }

  /* ---------------- submission (real lifecycle) ---------------- */

  async submit(): Promise<SubmissionResult> {
    if (this.state === 'disposed') return configError('FORM_DISPOSED', 'Form controller is disposed.');
    if (this.state === 'uninitialized' || this.state === 'compiling') {
      return configError('FORM_NOT_INITIALIZED', 'Call initialize() before submit().');
    }
    if (this.submitLock) return configError('SUBMISSION_IN_PROGRESS', 'A submission is already in progress.');
    this.submitLock = true;
    this.metrics.submissions += 1;
    const attemptId = this.newId();
    this.submission = { status: 'submitting', attemptId };
    this.transition('submitting');
    this.notify();
    try {
      const validation = await this.validate();
      if (!validation.valid) {
        const result: SubmissionResult = { status: 'validation-failed', issues: validation.issues };
        return this.finishSubmission(result, 'invalid');
      }
      // validate() may leave us in dirty/ready; re-enter submitting for the execution phase.
      this.transition('submitting');
      const def = this.ir.submission;
      if (!def) {
        return this.finishSubmission(configError('SUBMISSION_NOT_CONFIGURED', 'Form has no submission.operationRef configured.'), 'submission-failed');
      }
      // Client-side RBAC pre-check when an evaluator is registered (server re-enforces).
      if (this.ir.security.submitPermissions?.length && this.opts.rbac) {
        const decision = this.opts.rbac.evaluate(this.opts.auth, this.ir.security.submitPermissions);
        if (!decision.allowed) {
          return this.finishSubmission({
            status: 'permission-denied', code: 'PERMISSION_DENIED',
            message: `Missing permissions: ${decision.missing.join(', ')}`, requiredPermissions: decision.missing,
          }, 'submission-failed');
        }
      }
      const resolved = await resolveExecutor(this.opts.executors, { operationRef: def.operationRef, operationVersion: def.operationVersion });
      if ('error' in resolved) return this.finishSubmission(resolved.error, 'submission-failed');

      const { payload, issues } = buildSubmissionPayload(this.ir, this.values, this.effective, def);
      if (issues.some((i) => i.severity === 'error')) {
        return this.finishSubmission({ status: 'validation-failed', issues }, 'invalid');
      }
      const idempotencyKey = makeIdempotencyKey(def, this.ir.formId, this.values, this.newId);
      const correlationId = this.newId();
      const online = this.opts.isOnline?.() ?? true;

      if (!online) {
        const mayQueue = def.offline?.queue === true
          && this.ir.persistence.offline?.enabled === true
          && resolved.executor.contract.supportsOfflineQueue
          && this.opts.offlineQueue !== undefined;
        if (!mayQueue) {
          return this.finishSubmission({ status: 'network-failure', code: 'OFFLINE', message: 'Offline and this operation does not permit queueing.', retryable: true }, 'submission-failed');
        }
        const scopeKey = draftScopeKey(this.ir.persistence, this.opts.auth, this.opts.deviceId);
        const record: QueuedSubmissionRecord = {
          id: this.newId(), operationRef: def.operationRef, operationVersion: def.operationVersion,
          formId: this.ir.formId, formVersion: this.ir.formVersion, specVersion: this.ir.specVersion,
          scopeKey, values: payload, idempotencyKey, createdAt: this.now().toISOString(),
          status: 'queued', attempts: 0, maxAttempts: 5,
        };
        try {
          await this.opts.offlineQueue!.enqueue(record);
        } catch (e) {
          return this.finishSubmission(configError('OFFLINE_QUEUE_NOT_PERMITTED', (e as Error).message), 'submission-failed');
        }
        return this.finishSubmission({ status: 'queued-offline', queueId: record.id, idempotencyKey }, 'offline-queued');
      }

      this.submitController = new AbortController();
      const context: SubmissionContext = {
        formId: this.ir.formId, formVersion: this.ir.formVersion, specVersion: this.ir.specVersion,
        values: payload, authenticatedContext: this.opts.auth,
        idempotencyKey, correlationId, signal: this.submitController.signal,
      };
      let result: SubmissionResult;
      try {
        result = await resolved.executor.execute({ operationRef: def.operationRef, operationVersion: def.operationVersion }, context);
      } catch (e) {
        result = { status: 'network-failure', code: 'EXECUTOR_THREW', message: (e as Error).message, retryable: resolved.executor.contract.idempotent };
      }
      if (result.status === 'succeeded') {
        await this.runSuccessHooks(def, result);
        if (this.ir.persistence.drafts?.enabled && this.opts.drafts) await this.clearDraft();
        return this.finishSubmission(result, 'submission-succeeded');
      }
      if (result.status === 'queued-offline') return this.finishSubmission(result, 'offline-queued');
      if (result.status === 'server-validation-failed') {
        this.syncIssues = [...this.syncIssues.filter((i) => i.source !== 'server'), ...result.issues];
      }
      return this.finishSubmission(result, 'submission-failed');
    } finally {
      this.submitLock = false;
      this.submitController = null;
    }
  }

  private async runSuccessHooks(def: NonNullable<FormIR['submission']>, result: SubmissionResult & { status: 'succeeded' }): Promise<void> {
    for (const hook of def.onSuccess ?? []) {
      if (hook.condition) {
        const r = evaluateBoolean(hook.condition, { values: this.values, context: this.opts.context });
        if (!r.ok || r.value !== true) continue;
      }
      const resolved = await resolveExecutor(this.opts.executors, { operationRef: hook.operationRef });
      if ('error' in resolved) {
        this.pushDiag('HOOK_EXECUTOR_MISSING', `onSuccess hook "${hook.operationRef}": ${resolved.error.message}`);
        continue;
      }
      const payload: Record<string, unknown> = {};
      if (hook.inputMapping) {
        for (const [k, path] of Object.entries(hook.inputMapping)) payload[k] = getPath(this.values, path) ?? null;
      }
      payload._result = result.data;
      try {
        const hookResult = await resolved.executor.execute(
          { operationRef: hook.operationRef },
          {
            formId: this.ir.formId, formVersion: this.ir.formVersion, specVersion: this.ir.specVersion,
            values: payload, authenticatedContext: this.opts.auth,
            idempotencyKey: `${result.idempotencyKey}-hook-${hook.operationRef}`, correlationId: this.newId(),
          },
        );
        if (hookResult.status !== 'succeeded') {
          this.pushDiag('HOOK_FAILED', `onSuccess hook "${hook.operationRef}" returned ${hookResult.status}.`);
        }
      } catch (e) {
        this.pushDiag('HOOK_FAILED', `onSuccess hook "${hook.operationRef}" threw: ${(e as Error).message}`);
      }
    }
  }

  private finishSubmission(result: SubmissionResult, state: FormState): SubmissionResult {
    this.submission = {
      status: result.status === 'succeeded' ? 'succeeded' : result.status === 'queued-offline' ? 'queued' : 'failed',
      attemptId: this.submission.attemptId, result,
    };
    this.transition(state);
    this.snapshotCache = null;
    this.notify();
    return result;
  }

  cancelSubmission(): void { this.submitController?.abort(); }

  /* ---------------- reset / suspend / dispose ---------------- */

  reset(): void {
    if (this.state === 'disposed') return;
    this.values = structuredClone(this.initialValues);
    this.rowIds = JSON.parse(JSON.stringify(this.initialRowIds));
    this.touched = {};
    this.focusedPath = null;
    this.syncIssues = [];
    this.asyncIssues.clear();
    this.asyncStatus = {};
    this.submission = { status: 'idle' };
    for (const rule of this.ir.asyncRules) this.asyncValidator.cancel(rule.id);
    this.recomputeEffective();
    this.state = 'ready';
    this.snapshotCache = null;
    this.notify();
  }

  suspend(): void { this.transition('suspended'); this.notify(); }
  resume(): void {
    if (this.state === 'suspended') { this.state = this.isDirty() ? 'dirty' : 'ready'; this.notify(); }
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.asyncValidator.dispose();
    for (const c of this.dsControllers.values()) c.abort();
    this.dsControllers.clear();
    this.submitController?.abort();
    this.listeners.clear();
    this.fieldListeners.clear();
    this.state = 'disposed';
    this.snapshotCache = null;
  }

  private assertActive(): void {
    if (this.state === 'disposed') throw new Error('FORM_DISPOSED: controller has been disposed.');
    if (this.state === 'uninitialized') throw new Error('FORM_NOT_INITIALIZED: call initialize() first.');
  }

  private isDirty(): boolean { return !deepEqual(this.values, this.initialValues); }

  private pushDiag(code: string, message: string, path?: string): void {
    this.diagnostics.push({ code, message, path });
    if (this.diagnostics.length > 200) this.diagnostics.splice(0, this.diagnostics.length - 200);
    this.snapshotCache = null;
  }

  /* ---------------- subscriptions & snapshot ---------------- */

  getSnapshot(): FormSnapshot {
    if (this.snapshotCache) return this.snapshotCache;
    const repeaterRows: Record<string, string[]> = {};
    for (const r of this.repeaters) repeaterRows[r.id] = [...(this.rowIds[r.id] ?? [])];
    const dirtyPaths = this.computeDirtyPaths();
    this.snapshotCache = {
      state: this.state,
      values: structuredClone(this.values),
      dirty: dirtyPaths.length > 0,
      dirtyPaths,
      touched: { ...this.touched },
      focusedPath: this.focusedPath,
      issues: [...this.syncIssues, ...this.asyncIssues.values()],
      visibility: { ...this.effective.visibility },
      disabled: { ...this.effective.disabled },
      readonly: { ...this.effective.readonly },
      required: { ...this.effective.required },
      repeaterRows,
      dataSources: structuredClone(this.dsStatus),
      asyncValidation: { ...this.asyncStatus },
      submission: structuredClone(this.submission),
      draft: { ...this.draft },
      diagnostics: [...this.diagnostics],
      metrics: { ...this.metrics },
    };
    return this.snapshotCache;
  }

  private computeDirtyPaths(): string[] {
    const out: string[] = [];
    const walk = (a: unknown, b: unknown, prefix: string) => {
      if (deepEqual(a, b)) return;
      if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
        for (const k of keys) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k);
      } else {
        out.push(prefix);
      }
    };
    walk(this.initialValues, this.values, '');
    return out;
  }

  subscribe(listener: FormListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Selective subscription: notifies only when the slice at `path` changes. */
  subscribeField(path: string, listener: (slice: unknown) => void): () => void {
    if (!this.fieldListeners.has(path)) {
      this.fieldListeners.set(path, new Set());
      // Seed the slice cache so the first notification only fires on real change.
      this.fieldSliceCache.set(path, JSON.stringify(this.fieldSlice(path)));
    }
    this.fieldListeners.get(path)!.add(listener);
    return () => { this.fieldListeners.get(path)?.delete(listener); };
  }

  fieldSlice(path: string): unknown {
    const field = this.fieldForConcretePath(path);
    return {
      value: getPath(this.values, path) ?? null,
      touched: this.touched[path] === true,
      focused: this.focusedPath === path,
      issues: [...this.syncIssues, ...this.asyncIssues.values()].filter((i) => i.path === path),
      visible: field ? this.effective.visibility[field.id] !== false : true,
      required: field ? this.effective.required[field.id] === true : false,
      disabled: field ? this.effective.disabled[field.id] === true : false,
      readonly: field ? this.effective.readonly[field.id] === true : false,
    };
  }

  private notify(): void {
    this.snapshotCache = null;
    const snapshot = this.getSnapshot();
    for (const l of this.listeners) l(snapshot);
    for (const [path, set] of this.fieldListeners) {
      const slice = this.fieldSlice(path);
      const key = JSON.stringify(slice);
      if (this.fieldSliceCache.get(path) !== key) {
        this.fieldSliceCache.set(path, key);
        for (const l of set) l(slice);
      }
    }
  }

  /** Localized label helper for renderers. */
  label(fieldId: string): string {
    const f = this.ir.fields.find((x) => x.id === fieldId);
    return f ? localize(f.label, this.locale) : fieldId;
  }

  get uploadProvider(): UploadProvider | undefined { return this.opts.uploadProvider; }
  get auth(): AuthContext | undefined { return this.opts.auth; }
}

export function createFormController(options: RuntimeOptions): FormController {
  return new FormController(options);
}
