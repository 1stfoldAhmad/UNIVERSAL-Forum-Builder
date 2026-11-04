/**
 * @vds-form/inspector — explains what a form is doing, with sensitive-value redaction.
 * Never exposes secrets or privileged execution details.
 */
import type { FormIR, FormSnapshot, ValidationIssue } from '@vds-form/types';
import type { FormController } from '@vds-form/runtime';
import { defaultFieldRegistry, type FieldRegistry } from '@vds-form/fields';
import { localize } from '@vds-form/validation';

export interface InspectOptions {
  includeValues?: boolean;
  redactSensitive?: boolean;
  locale?: string;
  fields?: FieldRegistry;
}

export interface FieldInspection {
  id: string;
  key: string;
  type: string;
  label: string;
  value: unknown;
  valueType: string;
  visible: boolean;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  computed: boolean;
  touched: boolean;
  issues: ValidationIssue[];
  optionSourceId?: string;
  repeaterId?: string;
}

export interface RuntimeInspection {
  form: { id: string; version: string; specVersion: string; irVersion: string; compilerVersion: string; fingerprint: string };
  state: FormSnapshot['state'];
  dirty: boolean;
  dirtyPaths: string[];
  fields: FieldInspection[];
  repeaterRows: Record<string, string[]>;
  dependencies: FormIR['dependencies'];
  dataSources: FormSnapshot['dataSources'];
  asyncValidation: FormSnapshot['asyncValidation'];
  submission: { status: string; attemptId?: string; resultStatus?: string; executorSchemes: string[] };
  draft: FormSnapshot['draft'];
  requiredCapabilities: string[];
  diagnostics: FormSnapshot['diagnostics'];
  metrics: FormSnapshot['metrics'];
}

const REDACTED = '[REDACTED]';

export function inspectRuntime(controller: FormController, options: InspectOptions = {}): RuntimeInspection {
  const ir = controller.ir;
  const snap = controller.getSnapshot();
  const registry = options.fields ?? defaultFieldRegistry;
  const locale = options.locale ?? ir.localization.defaultLocale;
  const includeValues = options.includeValues !== false;
  const redact = options.redactSensitive !== false;

  const fields: FieldInspection[] = ir.fields.map((f) => {
    const contract = registry.get(f.type);
    const sensitive = contract?.sensitive === true;
    const concreteKeys = f.repeaterId
      ? (snap.repeaterRows[f.repeaterId] ?? []).map((_, i) => f.key.replace('[]', `.${i}`))
      : [f.key];
    let value: unknown = undefined;
    if (includeValues) {
      if (sensitive && redact) value = REDACTED;
      else if (f.repeaterId) value = concreteKeys.map((k) => getPathSafe(snap.values, k));
      else value = getPathSafe(snap.values, f.key);
    }
    return {
      id: f.id, key: f.key, type: f.type, label: localize(f.label, locale),
      value, valueType: f.valueType,
      visible: snap.visibility[f.id] !== false,
      required: snap.required[f.id] === true,
      disabled: snap.disabled[f.id] === true,
      readonly: snap.readonly[f.id] === true,
      computed: f.computed,
      touched: concreteKeys.some((k) => snap.touched[k]),
      issues: snap.issues.filter((i) => i.fieldId === f.id || concreteKeys.some((k) => i.path === k || i.path.startsWith(`${k}.`))),
      optionSourceId: f.optionSourceId,
      repeaterId: f.repeaterId,
    };
  });

  return {
    form: {
      id: ir.formId, version: ir.formVersion, specVersion: ir.specVersion,
      irVersion: ir.irVersion, compilerVersion: ir.compilerVersion, fingerprint: ir.fingerprint,
    },
    state: snap.state,
    dirty: snap.dirty,
    dirtyPaths: snap.dirtyPaths,
    fields,
    repeaterRows: snap.repeaterRows,
    dependencies: ir.dependencies,
    dataSources: snap.dataSources,
    asyncValidation: snap.asyncValidation,
    submission: {
      status: snap.submission.status,
      attemptId: snap.submission.attemptId,
      resultStatus: snap.submission.result?.status,
      executorSchemes: [], // populated by host if it chooses to expose registry metadata
    },
    draft: snap.draft,
    requiredCapabilities: ir.requiredCapabilities,
    diagnostics: snap.diagnostics,
    metrics: snap.metrics,
  };
}

function getPathSafe(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur ?? null;
}

/** Static compiled-form inspection (dependency visualization, references, capabilities). */
export function inspectIR(ir: FormIR) {
  return {
    form: { id: ir.formId, version: ir.formVersion, fingerprint: ir.fingerprint, compilerVersion: ir.compilerVersion },
    fieldCount: ir.fields.length,
    fields: ir.fields.map((f) => ({ id: f.id, key: f.key, type: f.type, valueType: f.valueType, computed: f.computed, sourcePointer: f.sourcePointer })),
    dependencyGraph: {
      nodes: [...new Set(ir.dependencies.edges.flatMap((e) => [e.from, e.to]))].sort(),
      edges: ir.dependencies.edges,
      evaluationOrder: ir.dependencies.order,
    },
    operationReferences: {
      submission: ir.submission?.operationRef ?? null,
      onSuccess: (ir.submission?.onSuccess ?? []).map((h) => h.operationRef),
      dataSources: ir.dataSources.map((d) => ({ id: d.id, providerRef: d.providerRef })),
      asyncValidation: ir.asyncRules.map((r) => ({ id: r.id, operationRef: r.operationRef })),
      model: undefined as string | undefined,
    },
    requiredCapabilities: ir.requiredCapabilities,
    sourceMap: ir.sourceMap,
  };
}
