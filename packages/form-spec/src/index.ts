import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  FORMAT_ID, SPEC_VERSION,
  type Diagnostic, type FormDocument,
} from '@vds-form/types';
import schemaJson from '../../../specifications/json-schema/vds-form-1.0.0.schema.json';

export const FORM_SCHEMA = schemaJson as unknown as Record<string, unknown>;

/** Specification versions this build understands structurally. */
export const SUPPORTED_SPEC_VERSIONS = ['1.0.0'] as const;
export const CURRENT_SPEC_VERSION = SPEC_VERSION;

let cached: ValidateFunction | null = null;
function validator(): ValidateFunction {
  if (!cached) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(ajv);
    cached = ajv.compile(FORM_SCHEMA);
  }
  return cached;
}

export interface StructuralValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

function ajvErrorToDiagnostic(e: ErrorObject): Diagnostic {
  const pointer = e.instancePath || '/';
  return {
    code: 'FORM_SCHEMA_INVALID',
    severity: 'error',
    message: `${pointer === '/' ? '(root)' : pointer}: ${e.message ?? 'invalid'}${e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : ''}`,
    path: pointer,
    suggestion: 'Fix the document to satisfy the vds.form 1.0.0 JSON Schema.',
  };
}

/**
 * Structural validation of an untrusted document. Never throws on bad input;
 * returns machine-readable diagnostics. Semantic checks live in the compiler.
 */
export function validateStructure(doc: unknown): StructuralValidationResult {
  const diagnostics: Diagnostic[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      valid: false,
      diagnostics: [{ code: 'FORM_SCHEMA_INVALID', severity: 'error', message: 'Form document must be a JSON object.', path: '/' }],
    };
  }
  const candidate = doc as Record<string, unknown>;
  if (candidate.format !== FORMAT_ID) {
    diagnostics.push({
      code: 'FORM_SCHEMA_INVALID', severity: 'error', path: '/format',
      message: `format must be "${FORMAT_ID}".`,
    });
  }
  if (typeof candidate.specVersion === 'string' && !SUPPORTED_SPEC_VERSIONS.includes(candidate.specVersion as never)) {
    diagnostics.push({
      code: 'FORM_VERSION_UNSUPPORTED', severity: 'error', path: '/specVersion',
      message: `specVersion "${candidate.specVersion}" is not supported (supported: ${SUPPORTED_SPEC_VERSIONS.join(', ')}).`,
      suggestion: 'Run `vds-form migrate` to upgrade the document.',
    });
  }
  const ok = validator()(doc);
  if (!ok) {
    for (const e of validator().errors ?? []) diagnostics.push(ajvErrorToDiagnostic(e));
  }
  // Deduplicate identical messages (AJV oneOf branches can repeat).
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const k = `${d.code}|${d.path}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { valid: unique.length === 0, diagnostics: unique };
}

/** Parse + structurally validate. Returns a typed document only when valid. */
export function parseFormDocument(input: string | unknown):
  | { ok: true; document: FormDocument }
  | { ok: false; diagnostics: Diagnostic[] } {
  let doc: unknown = input;
  if (typeof input === 'string') {
    if (input.length > 5_000_000) {
      return { ok: false, diagnostics: [{ code: 'LIMIT_EXCEEDED', severity: 'error', message: 'Form document exceeds 5 MB limit.' }] };
    }
    try {
      doc = JSON.parse(input);
    } catch (err) {
      return { ok: false, diagnostics: [{ code: 'FORM_SCHEMA_INVALID', severity: 'error', message: `Invalid JSON: ${(err as Error).message}` }] };
    }
  }
  const result = validateStructure(doc);
  if (!result.valid) return { ok: false, diagnostics: result.diagnostics };
  return { ok: true, document: doc as FormDocument };
}
