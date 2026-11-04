/**
 * @vds-form/compiler — deterministic JSON → FormIR compilation.
 * Pipeline: parse → structural schema → semantic validation → reference resolution
 * → field normalization → expression checks → dependency graph → capability analysis → IR.
 * No UI framework imports; diagnostics are stable and machine-readable.
 */
import {
  FORMAT_ID, IR_VERSION,
  type CompiledCondition, type CompiledCrossRule, type CompiledFormula,
  type DependencyEdge, type Diagnostic, type Expr, type FieldDef, type FormDocument,
  type FormIR, type LayoutNode, type NormalizedField, type ParsedRef,
  type RendererCapabilityManifest,
} from '@vds-form/types';
import { parseFormDocument } from '@vds-form/spec';
import {
  OPERATORS, OPERATOR_ARITY, collectRefs, isOpExpr, isRefExpr, measureExpr, parseRef,
  DEFAULT_LIMITS,
} from '@vds-form/expressions';
import {
  capabilitiesForField, defaultFieldRegistry, type FieldRegistry,
} from '@vds-form/fields';

export const COMPILER_VERSION = '1.0.0';
const MAX_NESTING_DEPTH = 8;

export interface CompileOptions {
  fields?: FieldRegistry;
  /** Target renderer manifest → capability negotiation. */
  target?: RendererCapabilityManifest;
  /** Registered operation refs (from project builders). When provided, unresolved refs are errors. */
  knownDataSourceOperations?: string[];
  knownSubmissionOperations?: string[];
}

export type CompileResult =
  | { ok: true; ir: FormIR; warnings: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

interface FlatField {
  def: FieldDef;
  pointer: string;
  depth: number;
  parentId?: string;
  repeaterId?: string;
  parentKey?: string;
  parentType?: string;
}

/* ---------------- canonical hashing (deterministic output) ---------------- */

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ---------------- helpers ---------------- */

const diag = (
  code: Diagnostic['code'], message: string, extra: Partial<Diagnostic> = {},
): Diagnostic => ({ code, severity: 'error', message, ...extra });

function templateToWildcard(key: string): string {
  return key.replace(/\[\]/g, '.*');
}

function flattenFields(fields: FieldDef[], diagnostics: Diagnostic[]): FlatField[] {
  const out: FlatField[] = [];
  const walk = (
    list: FieldDef[], pointerBase: string, depth: number,
    parentId?: string, repeaterId?: string, parentKey?: string, parentType?: string,
  ) => {
    if (depth > MAX_NESTING_DEPTH) {
      diagnostics.push(diag('LIMIT_EXCEEDED', `Field nesting exceeds ${MAX_NESTING_DEPTH} levels.`, { path: pointerBase }));
      return;
    }
    list.forEach((def, i) => {
      const pointer = `${pointerBase}/${i}`;
      out.push({ def, pointer, depth, parentId, repeaterId, parentKey, parentType });
      if (def.children?.length) {
        if (def.type === 'repeater' && repeaterId) {
          diagnostics.push(diag('FIELD_KEY_INVALID', 'Nested repeaters (repeater inside repeater) are not supported in spec 1.0.0.', { path: pointer, fieldId: def.id, suggestion: 'Model the inner collection as a separate form or flatten the structure.' }));
        }
        walk(
          def.children, `${pointer}/children`, depth + 1, def.id,
          def.type === 'repeater' ? def.id : repeaterId, def.key, def.type,
        );
      }
    });
  };
  walk(fields, '/fields', 1);
  return out;
}

function validateKeyStructure(flat: FlatField[], diagnostics: Diagnostic[]): void {
  const byId = new Map(flat.map((f) => [f.def.id, f]));
  for (const f of flat) {
    const { def } = f;
    if (def.children?.length && def.type !== 'group' && def.type !== 'repeater') {
      diagnostics.push(diag('FIELD_TYPE_UNKNOWN', `Field type "${def.type}" cannot have children (only group/repeater).`, { path: f.pointer, fieldId: def.id }));
    }
    if (f.parentKey !== undefined) {
      const expectedPrefix = f.parentType === 'repeater' ? `${f.parentKey}[].` : `${f.parentKey}.`;
      if (!def.key.startsWith(expectedPrefix)) {
        diagnostics.push(diag('FIELD_KEY_INVALID', `Child key "${def.key}" must start with "${expectedPrefix}".`, { path: f.pointer, fieldId: def.id, suggestion: `Use "${expectedPrefix}<name>".` }));
      }
      const rest = def.key.slice(expectedPrefix.length);
      if (rest.includes('.') && f.parentType === 'repeater') {
        // direct repeater children must be single-segment (groups handle deeper nesting)
        const owner = byId.get(f.parentId ?? '');
        if (owner?.def.type === 'repeater' && rest.split('.')[0].includes('[]')) {
          diagnostics.push(diag('FIELD_KEY_INVALID', `Invalid repeater child key "${def.key}".`, { path: f.pointer, fieldId: def.id }));
        }
      }
    } else if (def.key.includes('[]')) {
      diagnostics.push(diag('FIELD_KEY_INVALID', `Top-level key "${def.key}" cannot contain [].`, { path: f.pointer, fieldId: def.id }));
    }
  }
}

/** Semantic expression validation against known keys/sources/scope. */
function validateExprSemantics(
  expr: Expr, pointer: string, fieldId: string | undefined,
  validFieldPaths: Set<string>, repeaterChildPaths: Map<string, Set<string>>,
  sourceIds: Set<string>, rowScoped: boolean, ownerRepeaterKey: string | undefined,
  diagnostics: Diagnostic[],
): void {
  const m = measureExpr(expr);
  if (m.nodes > DEFAULT_LIMITS.maxNodes || m.depth > DEFAULT_LIMITS.maxDepth) {
    diagnostics.push(diag('LIMIT_EXCEEDED', `Expression exceeds budgets (${m.nodes} nodes, depth ${m.depth}).`, { path: pointer, fieldId }));
  }
  const walk = (e: Expr) => {
    if (isRefExpr(e)) {
      const parsed = parseRef(e.ref);
      if (!parsed) {
        diagnostics.push(diag('EXPRESSION_REFERENCE_INVALID', `Invalid reference "${e.ref}".`, { path: pointer, fieldId, reference: e.ref }));
        return;
      }
      if (parsed.kind === 'field' && !validFieldPaths.has(parsed.path)) {
        diagnostics.push(diag('EXPRESSION_REFERENCE_INVALID', `Unknown field path "${parsed.path}" in reference.`, { path: pointer, fieldId, reference: e.ref, suggestion: 'Reference an existing field key (use items.*.x for collections).' }));
      }
      if (parsed.kind === 'source' && !sourceIds.has(parsed.path)) {
        diagnostics.push(diag('DATA_SOURCE_UNRESOLVED', `Unknown data source "${parsed.path}".`, { path: pointer, fieldId, reference: e.ref }));
      }
      if ((parsed.kind === 'item' || parsed.kind === 'index') && !rowScoped) {
        diagnostics.push(diag('EXPRESSION_REFERENCE_INVALID', `"${e.ref}" is only valid inside a row-scoped formula (target containing []).`, { path: pointer, fieldId, reference: e.ref }));
      }
      if (parsed.kind === 'item' && rowScoped && ownerRepeaterKey) {
        const allowed = repeaterChildPaths.get(ownerRepeaterKey);
        if (allowed && !allowed.has(parsed.path.split('.')[0])) {
          diagnostics.push(diag('EXPRESSION_REFERENCE_INVALID', `item:${parsed.path} does not match a child of repeater "${ownerRepeaterKey}".`, { path: pointer, fieldId, reference: e.ref }));
        }
      }
    } else if (isOpExpr(e)) {
      if (!Object.hasOwn(OPERATORS, e.op)) {
        diagnostics.push(diag('EXPRESSION_PARSE_FAILED', `Unknown operator "${e.op}".`, { path: pointer, fieldId, reference: e.op, suggestion: 'Use a registered vds.expr/1 operator.' }));
      } else {
        const [min, max] = OPERATOR_ARITY[e.op];
        if (e.args.length < min || (max !== -1 && e.args.length > max)) {
          diagnostics.push(diag('EXPRESSION_PARSE_FAILED', `Operator "${e.op}" has wrong arity (${e.args.length}).`, { path: pointer, fieldId }));
        }
      }
      e.args.forEach(walk);
    }
  };
  walk(expr);
}

function findCycle(nodes: string[], edges: DependencyEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) { adj.set(n, []); indeg.set(n, 0); }
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of adj.get(n) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
    queue.sort();
  }
  if (order.length === nodes.length) return null;
  // DFS to report one concrete cycle.
  const remaining = new Set(nodes.filter((n) => !order.includes(n)));
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();
  let cycle: string[] | null = null;
  const dfs = (n: string) => {
    if (cycle) return;
    visited.add(n); stack.push(n); onStack.add(n);
    for (const next of adj.get(n) ?? []) {
      if (!remaining.has(next)) continue;
      if (onStack.has(next)) { cycle = [...stack.slice(stack.indexOf(next)), next]; return; }
      if (!visited.has(next)) dfs(next);
    }
    stack.pop(); onStack.delete(n);
  };
  for (const n of remaining) { if (!visited.has(n)) dfs(n); if (cycle) break; }
  return cycle ?? [...remaining];
}

export function topoOrder(nodes: string[], edges: DependencyEdge[]): string[] {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) { adj.set(n, []); indeg.set(n, 0); }
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of (adj.get(n) ?? []).slice().sort()) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
    queue.sort();
  }
  return order;
}

/* ---------------- main entry ---------------- */

export function compileForm(input: unknown, options: CompileOptions = {}): CompileResult {
  const parsed = parseFormDocument(input);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const doc: FormDocument = parsed.document;
  const registry = options.fields ?? defaultFieldRegistry;
  const diagnostics: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  /* flatten + identity checks */
  const flat = flattenFields(doc.fields, diagnostics);
  validateKeyStructure(flat, diagnostics);
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const f of flat) {
    if (seenIds.has(f.def.id)) diagnostics.push(diag('FIELD_ID_DUPLICATE', `Duplicate field id "${f.def.id}".`, { path: f.pointer, fieldId: f.def.id }));
    seenIds.add(f.def.id);
    if (seenKeys.has(f.def.key)) diagnostics.push(diag('FIELD_KEY_DUPLICATE', `Duplicate field key "${f.def.key}".`, { path: f.pointer, fieldId: f.def.key }));
    seenKeys.add(f.def.key);
    if (!registry.has(f.def.type)) {
      diagnostics.push(diag('FIELD_TYPE_UNKNOWN', `Unknown field type "${f.def.type}".`, { path: f.pointer, fieldId: f.def.id, suggestion: `Registered types: ${registry.list().map((c) => c.type).join(', ')}` }));
    }
  }
  const flatById = new Map(flat.map((f) => [f.def.id, f]));
  const flatByKey = new Map(flat.map((f) => [f.def.key, f]));
  const topLevel = flat.filter((f) => f.depth === 1);

  /* valid expression field paths: concrete templates + wildcard projections + containers */
  const validFieldPaths = new Set<string>();
  const repeaterChildPaths = new Map<string, Set<string>>();
  for (const f of flat) {
    validFieldPaths.add(templateToWildcard(f.def.key));
    if (f.repeaterId && f.parentType === 'repeater') {
      const owner = flatById.get(f.repeaterId)!;
      const rel = f.def.key.slice(owner.def.key.length + 3); // remove `key[].`
      const set = repeaterChildPaths.get(owner.def.key) ?? new Set<string>();
      set.add(rel.split('.')[0]);
      repeaterChildPaths.set(owner.def.key, set);
    }
  }
  const sourceIds = new Set((doc.dataSources ?? []).map((s) => s.id));

  /* data sources */
  const seenSources = new Set<string>();
  (doc.dataSources ?? []).forEach((s, i) => {
    const pointer = `/dataSources/${i}`;
    if (seenSources.has(s.id)) diagnostics.push(diag('DATA_SOURCE_DUPLICATE', `Duplicate data source id "${s.id}".`, { path: pointer }));
    seenSources.add(s.id);
    if (options.knownDataSourceOperations && !options.knownDataSourceOperations.includes(s.providerRef)) {
      diagnostics.push(diag('DATA_SOURCE_UNRESOLVED', `Data source operation "${s.providerRef}" is not registered in this project.`, { path: pointer, reference: s.providerRef }));
    } else if (!options.knownDataSourceOperations) {
      warnings.push({ ...diag('DATA_SOURCE_UNRESOLVED', `Data source "${s.providerRef}" will be resolved at runtime by a registered provider.`, { path: pointer, reference: s.providerRef }), severity: 'warning' });
    }
    for (const [k, v] of Object.entries(s.params ?? {})) {
      if (typeof v === 'object' && v !== null && ('ref' in v || 'op' in v || 'const' in v)) {
        validateExprSemantics(v as Expr, `${pointer}/params/${k}`, undefined, validFieldPaths, repeaterChildPaths, sourceIds, false, undefined, diagnostics);
      }
    }
  });

  /* option source bindings */
  for (const f of flat) {
    const opts = f.def.options;
    if (opts && !Array.isArray(opts)) {
      if (!sourceIds.has(opts.sourceId)) {
        diagnostics.push(diag('DATA_SOURCE_UNRESOLVED', `Field "${f.def.id}" binds unknown option source "${opts.sourceId}".`, { path: f.pointer, fieldId: f.def.id, reference: opts.sourceId }));
      }
    }
  }

  /* conditions */
  const conditions: CompiledCondition[] = [];
  const seenCond = new Set<string>();
  (doc.logic?.conditions ?? []).forEach((c, i) => {
    const pointer = `/logic/conditions/${i}`;
    if (seenCond.has(c.id)) diagnostics.push(diag('CONDITION_DUPLICATE', `Duplicate condition id "${c.id}".`, { path: pointer }));
    seenCond.add(c.id);
    validateExprSemantics(c.when, `${pointer}/when`, undefined, validFieldPaths, repeaterChildPaths, sourceIds, false, undefined, diagnostics);
    for (const eff of c.effects) {
      if (!flatById.has(eff.fieldId)) {
        diagnostics.push(diag('FIELD_REFERENCE_INVALID', `Condition "${c.id}" targets unknown field "${eff.fieldId}".`, { path: pointer, reference: eff.fieldId }));
      }
    }
    conditions.push({ id: c.id, when: c.when, effects: c.effects, reads: collectRefs(c.when) });
  });

  /* formulas */
  const formulas: CompiledFormula[] = [];
  const seenFormula = new Set<string>();
  const formulaTargets = new Set<string>();
  (doc.logic?.formulas ?? []).forEach((f, i) => {
    const pointer = `/logic/formulas/${i}`;
    if (seenFormula.has(f.id)) diagnostics.push(diag('FORMULA_DUPLICATE', `Duplicate formula id "${f.id}".`, { path: pointer }));
    seenFormula.add(f.id);
    const targetField = flatByKey.get(f.target);
    if (!targetField) {
      diagnostics.push(diag('FORMULA_TARGET_INVALID', `Formula target "${f.target}" is not a field key.`, { path: pointer, reference: f.target }));
    } else if (formulaTargets.has(f.target)) {
      diagnostics.push(diag('FORMULA_TARGET_INVALID', `Multiple formulas target "${f.target}".`, { path: pointer, reference: f.target }));
    }
    formulaTargets.add(f.target);
    const rowScoped = f.target.includes('[]');
    const ownerRepeaterKey = rowScoped ? f.target.slice(0, f.target.indexOf('[]')) : undefined;
    validateExprSemantics(f.expr, `${pointer}/expr`, f.id, validFieldPaths, repeaterChildPaths, sourceIds, rowScoped, ownerRepeaterKey, diagnostics);
    formulas.push({ id: f.id, target: f.target, expr: f.expr, reads: collectRefs(f.expr), rowScoped });
  });

  /* cross-field + async validation rules */
  const crossFieldRules: CompiledCrossRule[] = [];
  (doc.validation?.crossField ?? []).forEach((r, i) => {
    const pointer = `/validation/crossField/${i}`;
    validateExprSemantics(r.expr, `${pointer}/expr`, r.id, validFieldPaths, repeaterChildPaths, sourceIds, false, undefined, diagnostics);
    if (r.path && !validFieldPaths.has(templateToWildcard(r.path))) {
      diagnostics.push(diag('VALIDATION_RULE_INVALID', `Cross-field rule path "${r.path}" is not a field key.`, { path: pointer, reference: r.path }));
    }
    crossFieldRules.push({ id: r.id, expr: r.expr, message: r.message, path: r.path, severity: r.severity ?? 'error', reads: collectRefs(r.expr) });
  });
  const asyncRules = doc.validation?.async ?? [];
  asyncRules.forEach((r, i) => {
    const pointer = `/validation/async/${i}`;
    if (!validFieldPaths.has(r.path)) {
      diagnostics.push(diag('VALIDATION_RULE_INVALID', `Async rule path "${r.path}" is not a field key.`, { path: pointer, reference: r.path }));
    }
    if (options.knownDataSourceOperations && !options.knownDataSourceOperations.includes(r.operationRef)) {
      diagnostics.push(diag('DATA_SOURCE_UNRESOLVED', `Async validation operation "${r.operationRef}" is not registered.`, { path: pointer, reference: r.operationRef }));
    }
  });

  /* submission */
  if (doc.submission) {
    const pointer = '/submission';
    if (options.knownSubmissionOperations && !options.knownSubmissionOperations.includes(doc.submission.operationRef)) {
      diagnostics.push(diag('SUBMISSION_OPERATION_UNRESOLVED', `Submission operation "${doc.submission.operationRef}" is not registered in this project.`, { path: pointer, reference: doc.submission.operationRef }));
    } else if (!options.knownSubmissionOperations) {
      warnings.push({ ...diag('SUBMISSION_OPERATION_UNRESOLVED', `Submission operation "${doc.submission.operationRef}" will be resolved at runtime by a registered executor.`, { path: pointer, reference: doc.submission.operationRef }), severity: 'warning' });
    }
    for (const [param, path] of Object.entries(doc.submission.inputMapping ?? {})) {
      if (!validFieldPaths.has(path) && !flatByKey.has(path)) {
        diagnostics.push(diag('SUBMISSION_MAPPING_INVALID', `inputMapping "${param}" → "${path}" does not reference a field key.`, { path: `${pointer}/inputMapping`, reference: path }));
      }
    }
    for (const hook of doc.submission.onSuccess ?? []) {
      if (hook.condition) validateExprSemantics(hook.condition, `${pointer}/onSuccess`, undefined, validFieldPaths, repeaterChildPaths, sourceIds, false, undefined, diagnostics);
    }
  }

  /* layout normalization + reference checks */
  const placed = new Set<string>();
  const validateLayout = (node: LayoutNode, pointer: string, insideRepeater: boolean) => {
    for (const ref of node.fieldRefs ?? []) {
      const target = flatById.get(ref);
      if (!target) {
        diagnostics.push(diag('LAYOUT_REFERENCE_INVALID', `Layout references unknown field "${ref}".`, { path: pointer, reference: ref }));
      } else if (!insideRepeater && target.depth !== 1) {
        diagnostics.push(diag('LAYOUT_REFERENCE_INVALID', `Layout fieldRefs must reference top-level fields ("${ref}" is nested; it renders inside its group/repeater).`, { path: pointer, reference: ref }));
      } else placed.add(ref);
    }
    if (node.type === 'repeater') {
      const rep = node.repeaterRef ? flatById.get(node.repeaterRef) : undefined;
      if (!node.repeaterRef || !rep || rep.def.type !== 'repeater') {
        diagnostics.push(diag('LAYOUT_REFERENCE_INVALID', 'Repeater layout node requires a valid repeaterRef.', { path: pointer, reference: node.repeaterRef }));
      } else placed.add(node.repeaterRef);
    }
    (node.children ?? []).forEach((c, i) => validateLayout(c, `${pointer}/children/${i}`, insideRepeater || node.type === 'repeater'));
  };
  let layout: LayoutNode;
  if (doc.layout) {
    validateLayout(doc.layout, '/layout', false);
    const missing = topLevel.filter((f) => !placed.has(f.def.id) && !f.def.hidden);
    layout = missing.length
      ? { type: 'section', id: 'root', children: [doc.layout, { type: 'group', id: '__auto__', fieldRefs: missing.map((f) => f.def.id) }] }
      : doc.layout;
  } else {
    layout = { type: 'section', id: 'root', fieldRefs: topLevel.filter((f) => !f.def.hidden).map((f) => f.def.id) };
  }

  /* capability analysis */
  const requiredCapabilities = new Set(doc.capabilities?.required ?? []);
  for (const f of flat) for (const c of capabilitiesForField(f.def.type, f.def.ui?.widget)) requiredCapabilities.add(c);
  if (doc.layout && JSON.stringify(doc.layout).includes('"steps"')) requiredCapabilities.add('multi-step');
  if (options.target) {
    const t = options.target;
    for (const f of flat) {
      if (f.def.type === 'group' || f.def.type === 'repeater') continue; // structural, handled by layout features
      const fc = t.fieldTypes[f.def.type];
      if (!fc) {
        diagnostics.push(diag('PLATFORM_CAPABILITY_UNSUPPORTED', `Target "${t.target}" does not support field type "${f.def.type}".`, { fieldId: f.def.id, reference: f.def.type, suggestion: 'Choose a supporting target or change the field type.' }));
      } else if (fc.fallbackStrategy) {
        warnings.push({ ...diag('PLATFORM_CAPABILITY_UNSUPPORTED', `Field "${f.def.id}" uses fallback "${fc.fallbackStrategy}" on "${t.target}".`, { fieldId: f.def.id }), severity: 'warning' });
      }
    }
    const featureFor: Record<string, keyof RendererCapabilityManifest['features']> = {
      'file-upload': 'filePicker', camera: 'camera', signature: 'signature', repeaters: 'repeaters', 'multi-step': 'multiStep', 'rich-text': 'richText',
    };
    for (const capName of requiredCapabilities) {
      const feature = featureFor[capName];
      if (feature && !t.features[feature]) {
        diagnostics.push(diag('PLATFORM_CAPABILITY_UNSUPPORTED', `Target "${t.target}" lacks required capability "${capName}".`, { reference: capName }));
      }
    }
    if (doc.layout && JSON.stringify(doc.layout).includes('"repeater"') && !t.features.repeaters) {
      diagnostics.push(diag('PLATFORM_CAPABILITY_UNSUPPORTED', `Target "${t.target}" lacks repeater support.`, { reference: 'repeaters' }));
    }
    if (flat.some((f) => f.def.type === 'repeater') && !t.features.repeaters) {
      diagnostics.push(diag('PLATFORM_CAPABILITY_UNSUPPORTED', `Target "${t.target}" lacks repeater support.`, { reference: 'repeaters' }));
    }
  }

  if (diagnostics.length) return { ok: false, diagnostics };

  /* normalize fields */
  const normalized: NormalizedField[] = flat.map((f) => {
    const contract = registry.get(f.def.type)!;
    const d = f.def;
    const isFormulaTarget = formulaTargets.has(d.key);
    const opts = Array.isArray(d.options) ? d.options : undefined;
    const optSource = d.options && !Array.isArray(d.options) ? d.options : undefined;
    return {
      id: d.id, type: d.type, key: d.key,
      valueType: d.valueType ?? contract.valueType,
      label: d.label ?? d.id,
      description: d.description,
      defaultValue: d.defaultValue !== undefined ? d.defaultValue : contract.defaultValue,
      required: d.required ?? false,
      disabled: d.disabled ?? false,
      readonly: (d.readonly ?? false) || d.type === 'computed' || isFormulaTarget,
      hidden: d.hidden ?? false,
      computed: (d.computed ?? false) || isFormulaTarget,
      validation: { ...contract.builtInValidation, ...d.validation },
      options: opts,
      optionSourceId: optSource?.sourceId,
      optionValueKey: optSource?.valueKey ?? 'value',
      optionLabelKey: optSource?.labelKey ?? 'label',
      ui: d.ui ?? {},
      accessibility: d.accessibility ?? {},
      parentId: f.parentId,
      repeaterId: f.repeaterId,
      children: (d.children ?? []).map((c) => c.id),
      sourcePointer: f.pointer,
    };
  });

  /* dependency graph */
  const nodeIds = new Set<string>();
  const edges: DependencyEdge[] = [];
  const fieldNode = (key: string) => `f:${key}`;
  for (const f of normalized) nodeIds.add(fieldNode(f.key));
  for (const s of doc.dataSources ?? []) nodeIds.add(`s:${s.id}`);
  const readNode = (r: ParsedRef, rowScoped: boolean, ownerKey?: string): string | null => {
    if (r.kind === 'field') {
      // normalize wildcard to template for graph identity
      const template = r.path.replace(/\.\*/g, '[]');
      if (flatByKey.has(template)) return fieldNode(template);
      // container prefix (e.g. items for items.*.qty when items is repeater)
      const root = r.path.split('.')[0].replace('[]', '');
      const owner = normalized.find((n) => n.key === root);
      return owner ? fieldNode(owner.key) : null;
    }
    if (r.kind === 'item' && rowScoped && ownerKey) return fieldNode(`${ownerKey}[].${r.path}`);
    if (r.kind === 'parent') return flatByKey.has(r.path) ? fieldNode(r.path) : null;
    if (r.kind === 'source') return `s:${r.path}`;
    return null;
  };
  for (const s of doc.dataSources ?? []) {
    for (const v of Object.values(s.params ?? {})) {
      if (typeof v === 'object' && v !== null && ('ref' in v || 'op' in v || 'const' in v)) {
        for (const r of collectRefs(v as Expr)) {
          const from = readNode(r, false);
          if (from) { edges.push({ from, to: `s:${s.id}`, kind: 'options' }); nodeIds.add(from); }
        }
      }
    }
  }
  for (const f of normalized) {
    if (f.optionSourceId) edges.push({ from: `s:${f.optionSourceId}`, to: fieldNode(f.key), kind: 'options' });
  }
  for (const c of conditions) {
    const cid = `c:${c.id}`;
    nodeIds.add(cid);
    for (const r of c.reads) { const from = readNode(r, false); if (from) { edges.push({ from, to: cid, kind: 'condition' }); nodeIds.add(from); } }
    for (const eff of c.effects) edges.push({ from: cid, to: fieldNode(flatById.get(eff.fieldId)!.def.key), kind: 'condition' });
  }
  for (const f of formulas) {
    const fid = `F:${f.id}`;
    nodeIds.add(fid);
    const ownerKey = f.rowScoped ? f.target.slice(0, f.target.indexOf('[]')) : undefined;
    for (const r of f.reads) { const from = readNode(r, f.rowScoped, ownerKey); if (from) { edges.push({ from, to: fid, kind: 'formula' }); nodeIds.add(from); } }
    edges.push({ from: fid, to: fieldNode(f.target), kind: 'formula' });
  }
  for (const r of crossFieldRules) {
    const vid = `v:${r.id}`;
    nodeIds.add(vid);
    for (const read of r.reads) { const from = readNode(read, false); if (from) { edges.push({ from, to: vid, kind: 'validation' }); nodeIds.add(from); } }
  }
  const nodes = [...nodeIds].sort();
  const cycle = findCycle(nodes, edges);
  if (cycle) {
    return { ok: false, diagnostics: [diag('DEPENDENCY_CYCLE_DETECTED', `Dependency cycle: ${cycle.join(' → ')}.`, { reference: cycle.join(' → '), suggestion: 'Remove one of the dependencies to break the cycle.' })] };
  }
  const order = topoOrder(nodes, edges);

  const sourceMap: Record<string, string> = {};
  for (const f of flat) sourceMap[fieldNode(f.def.key)] = f.pointer;
  conditions.forEach((c, i) => { sourceMap[`c:${c.id}`] = `/logic/conditions/${i}`; });
  formulas.forEach((f, i) => { sourceMap[`F:${f.id}`] = `/logic/formulas/${i}`; });
  (doc.dataSources ?? []).forEach((s, i) => { sourceMap[`s:${s.id}`] = `/dataSources/${i}`; });

  const ir: FormIR = {
    irVersion: IR_VERSION,
    specVersion: doc.specVersion,
    compilerVersion: COMPILER_VERSION,
    formId: doc.id,
    formVersion: doc.metadata.version ?? '0.0.0',
    fields: normalized,
    layout,
    conditions,
    formulas,
    crossFieldRules,
    asyncRules,
    dataSources: doc.dataSources ?? [],
    submission: doc.submission,
    persistence: doc.persistence ?? {},
    security: doc.security ?? {},
    localization: { defaultLocale: doc.localization?.defaultLocale ?? 'en', locales: doc.localization?.locales ?? [doc.localization?.defaultLocale ?? 'en'] },
    requiredCapabilities: [...requiredCapabilities].sort(),
    dependencies: { edges, order },
    sourceMap,
    fingerprint: '',
  };
  ir.fingerprint = fnv1aHex(canonicalStringify(ir));
  return { ok: true, ir, warnings };
}
