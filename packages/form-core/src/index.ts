/**
 * @vds-form/core — public facade: compile + create a runtime in one call.
 * Re-exports the shared contracts so consumers need a single dependency.
 */
import { compileForm, type CompileOptions } from '@vds-form/compiler';
import { FormController, type RuntimeOptions } from '@vds-form/runtime';
import type { Diagnostic, FormDocument } from '@vds-form/types';

export * from '@vds-form/types';
export { parseFormDocument, validateStructure, FORM_SCHEMA, CURRENT_SPEC_VERSION, SUPPORTED_SPEC_VERSIONS } from '@vds-form/spec';
export { compileForm, COMPILER_VERSION, canonicalStringify, fnv1aHex, type CompileOptions, type CompileResult } from '@vds-form/compiler';
export {
  evaluate, evaluateBoolean, compileDsl, DslSyntaxError, collectRefs, parseRef,
  getPath, setIn, deleteIn, deepEqual, OPERATORS, OPERATOR_NAMES, DEFAULT_LIMITS,
} from '@vds-form/expressions';
export { defaultFieldRegistry, createDefaultFieldRegistry, FieldRegistry, BUILTIN_FIELD_CONTRACTS, type FieldContract } from '@vds-form/fields';
export { validateValues, computeEffectiveState, AsyncValidator, localize, isEmptyValue, isSafePattern, expandFieldInstances, type EffectiveFieldState } from '@vds-form/validation';
export { FormController, createFormController, type RuntimeOptions, type FormListener } from '@vds-form/runtime';
export { SubmissionExecutorRegistry, buildSubmissionPayload, makeIdempotencyKey, replayOfflineQueue, resolveExecutor, configError } from '@vds-form/submission';
export { DataSourceProviderRegistry, DataSourceCache, evaluateParams, mapOptions } from '@vds-form/data-sources';
export { MemoryDraftStorage, MemoryOfflineQueue, draftScopeKey, loadDraftChecked, makeDraftEnvelope } from '@vds-form/persistence';

export interface CreateFormOptions extends Omit<RuntimeOptions, 'ir'>, CompileOptions {
  document: FormDocument | string | unknown;
}

export type CreateFormResult =
  | { ok: true; controller: FormController; warnings: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

/** Compile a canonical document and construct a headless controller (not yet initialized). */
export function createForm(options: CreateFormOptions): CreateFormResult {
  const { document, ...rest } = options;
  const compiled = compileForm(document, rest);
  if (!compiled.ok) return compiled;
  const controller = new FormController({ ...rest, ir: compiled.ir });
  return { ok: true, controller, warnings: compiled.warnings };
}
