/**
 * @vds-form/mcp — Model Context Protocol server exposing the Form Builder's
 * real, contract-backed tools to AI hosts.
 *
 * Phase 0 discovery found NO public VDS Plugin-Host/MCP builder repo, so this
 * server does not invent VDS APIs: it exposes the canonical form standard's
 * own operations (validate/compile/inspect/migrate/capabilities/conformance).
 * Every tool is gated by a host-granted permission (fail-closed: a tool whose
 * permission was not granted returns a structured MCP_PERMISSION_DENIED result
 * and never executes). Tools never self-grant.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  parseFormDocument, compileForm, CURRENT_SPEC_VERSION, defaultFieldRegistry,
} from '@vds-form/core';
import { inspectIR } from '@vds-form/inspector';
import { createDefaultMigrationRegistry } from '@vds-form/migrations';
import { runConformance } from '@vds-form/conformance';
import type { RendererCapabilityManifest } from '@vds-form/types';

export const FORM_MCP_PERMISSIONS = [
  'form:validate', 'form:compile', 'form:inspect',
  'form:migrate', 'form:capabilities', 'form:conformance',
] as const;
export type FormMcpPermission = typeof FORM_MCP_PERMISSIONS[number];

export interface FormMcpOptions {
  /** Permissions granted by the host. Defaults to [] (fail-closed). */
  grantedPermissions?: string[];
  name?: string;
  version?: string;
}

const documentSchema = z.union([z.string(), z.record(z.unknown())]).describe('Canonical vds.form document (JSON object or string).');

function jsonResult(data: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError };
}

function genericCapabilityManifest(): RendererCapabilityManifest {
  return {
    target: 'generic',
    contractVersion: '1.0.0',
    fieldTypes: Object.fromEntries(defaultFieldRegistry.list().map((c) => [c.type, { ...c.capability }])),
    features: {
      dragDrop: false, filePicker: false, camera: false, offlineQueue: true,
      draftPersistence: true, multiStep: true, repeaters: true, richText: false, signature: false,
    },
  };
}

/** Create a permission-gated MCP server. Connect it to a transport (stdio or in-memory). */
export function createFormMcpServer(options: FormMcpOptions = {}): McpServer {
  const granted = new Set(options.grantedPermissions ?? []);
  const server = new McpServer({ name: options.name ?? 'vds-form-builder', version: options.version ?? '1.0.0' });

  const gate = (permission: FormMcpPermission): boolean => granted.has(permission);
  const deny = (permission: FormMcpPermission) =>
    jsonResult({ ok: false, code: 'MCP_PERMISSION_DENIED', message: `Permission "${permission}" was not granted by the host.` }, true);

  server.registerTool('validate_form', {
    title: 'Validate form document',
    description: 'Validate a canonical vds.form document against the JSON Schema (Draft 2020-12). Requires form:validate.',
    inputSchema: { document: documentSchema },
  }, async ({ document }) => {
    if (!gate('form:validate')) return deny('form:validate');
    const result = parseFormDocument(document);
    if (!result.ok) return jsonResult({ ok: false, diagnostics: result.diagnostics }, true);
    return jsonResult({ ok: true, formId: result.document.id, specVersion: result.document.specVersion });
  });

  server.registerTool('compile_form', {
    title: 'Compile form to FormIR',
    description: 'Compile a canonical document to deterministic FormIR with diagnostics. Requires form:compile.',
    inputSchema: { document: documentSchema },
  }, async ({ document }) => {
    if (!gate('form:compile')) return deny('form:compile');
    const parsed = parseFormDocument(document);
    if (!parsed.ok) return jsonResult({ ok: false, diagnostics: parsed.diagnostics }, true);
    const result = compileForm(parsed.document);
    if (!result.ok) return jsonResult({ ok: false, diagnostics: result.diagnostics }, true);
    return jsonResult({
      ok: true, formId: result.ir.formId, fieldCount: result.ir.fields.length,
      fingerprint: result.ir.fingerprint, requiredCapabilities: result.ir.requiredCapabilities,
      warnings: result.warnings, ir: result.ir,
    });
  });

  server.registerTool('inspect_form', {
    title: 'Inspect compiled form',
    description: 'Return dependency graph, operation references and required capabilities (secrets redacted). Requires form:inspect.',
    inputSchema: { document: documentSchema },
  }, async ({ document }) => {
    if (!gate('form:inspect')) return deny('form:inspect');
    const parsed = parseFormDocument(document);
    if (!parsed.ok) return jsonResult({ ok: false, diagnostics: parsed.diagnostics }, true);
    const result = compileForm(parsed.document);
    if (!result.ok) return jsonResult({ ok: false, diagnostics: result.diagnostics }, true);
    return jsonResult({ ok: true, inspection: inspectIR(result.ir) });
  });

  server.registerTool('migrate_form', {
    title: 'Migrate form document',
    description: `Migrate a document toward spec ${CURRENT_SPEC_VERSION} (backup preserved, lossy steps opt-in). Requires form:migrate.`,
    inputSchema: {
      document: documentSchema,
      targetVersion: z.string().optional().describe(`Target spec version (default ${CURRENT_SPEC_VERSION}).`),
      allowLossy: z.boolean().optional().describe('Accept lossy migration steps.'),
    },
  }, async ({ document, targetVersion, allowLossy }) => {
    if (!gate('form:migrate')) return deny('form:migrate');
    const input = typeof document === 'string' ? JSON.parse(document) : document;
    const registry = createDefaultMigrationRegistry();
    const result = registry.migrate(input, targetVersion ?? CURRENT_SPEC_VERSION, { allowLossy });
    if (!result.ok) return jsonResult({ ok: false, diagnostics: result.diagnostics, backup: result.backup }, true);
    return jsonResult({ ok: true, applied: result.applied, document: result.document });
  });

  server.registerTool('list_capabilities', {
    title: 'List field capabilities',
    description: 'Return the generic field-capability manifest for renderer negotiation. Requires form:capabilities.',
    inputSchema: {},
  }, async () => {
    if (!gate('form:capabilities')) return deny('form:capabilities');
    return jsonResult({ ok: true, manifest: genericCapabilityManifest() });
  });

  server.registerTool('run_conformance', {
    title: 'Run conformance suite',
    description: 'Run the shared cross-language conformance fixtures against the TS core. Requires form:conformance.',
    inputSchema: {},
  }, async () => {
    if (!gate('form:conformance')) return deny('form:conformance');
    const report = runConformance();
    return jsonResult({ ok: report.failed === 0, ...report }, report.failed !== 0);
  });

  return server;
}
