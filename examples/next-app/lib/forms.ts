/**
 * SERVER-ONLY form registry and compilation.
 *
 * The canonical `vds.form` document is compiled to FormIR on the server. Only
 * the compiled IR crosses the client boundary — never the compiler, the trusted
 * handler, the operation registry or any credential.
 *
 * The definition is a STATIC import of the shared canonical example, so the
 * bundler traces exactly one file. Reading it with `fs` at a computed path would
 * make Next trace the whole repository into the server output.
 * A real application would load its definitions from its own datastore here.
 */
import 'server-only';
import { compileForm } from '@vds-form/compiler';
import type { FormDocument, FormIR } from '@vds-form/types';
import contactForm from '../../forms/contact.vds.json';

export const FORM_IDS = ['contact'] as const;
export type FormId = (typeof FORM_IDS)[number];

const DOCUMENTS: Record<FormId, FormDocument> = {
  contact: contactForm as unknown as FormDocument,
};

export function loadFormDocument(id: FormId): FormDocument {
  return DOCUMENTS[id];
}

/** Compiles on the server; throws on an invalid definition (never ships bad IR). */
export function compileFormServer(id: FormId): FormIR {
  const result = compileForm(loadFormDocument(id));
  if (!result.ok) {
    throw new Error(`Form "${id}" failed to compile: ${result.diagnostics.map((d) => d.message).join('; ')}`);
  }
  return result.ir;
}

/**
 * FormIR is plain JSON by construction. This guard makes the boundary explicit:
 * anything non-serializable (functions, class instances, undefined) is a bug and
 * must fail the build rather than silently break hydration.
 */
export function serializeFormIR(ir: FormIR): string {
  return JSON.stringify(ir);
}
