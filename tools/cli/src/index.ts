/**
 * @vds-form/cli — `vds-form` command line.
 * Commands: validate | compile | inspect | migrate | capabilities | conformance.
 * The core `runCli` is IO-injected so it is fully testable without spawning a
 * process or touching the real filesystem/stdout.
 */
import { parseArgs } from 'node:util';
import {
  parseFormDocument, CURRENT_SPEC_VERSION,
  compileForm, defaultFieldRegistry,
} from '@vds-form/core';
import { inspectIR } from '@vds-form/inspector';
import { createDefaultMigrationRegistry } from '@vds-form/migrations';
import { runConformance } from '@vds-form/conformance';
import type { Diagnostic, RendererCapabilityManifest } from '@vds-form/types';

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  readFile: (path: string) => string;
}

const USAGE = `vds-form — VDS Universal Form Builder CLI (spec ${CURRENT_SPEC_VERSION})

Usage:
  vds-form validate <file>                 Validate a canonical form document against the JSON Schema.
  vds-form compile <file> [--json]         Compile to FormIR. --json prints the full IR.
                 [--capabilities <file>]   Negotiate against a renderer capability manifest.
  vds-form inspect <file>                  Print dependency graph, operation references, capabilities.
  vds-form migrate <file> [--to <ver>]     Migrate a document (default target ${CURRENT_SPEC_VERSION}).
                 [--allow-lossy] [--json]  Accept lossy steps; --json prints the migrated document.
  vds-form capabilities                    Print the generic field-capability manifest.
  vds-form conformance [--json]            Run the shared conformance fixtures; non-zero exit on failure.

Options:
  --json            Machine-readable JSON output.
  -h, --help        Show this help.

Exit codes: 0 success · 1 validation/compile/conformance failure · 2 usage error.`;

function printDiagnostics(io: CliIO, diagnostics: Diagnostic[]): void {
  io.err(JSON.stringify({ ok: false, diagnostics }, null, 2));
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

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        to: { type: 'string' },
        'allow-lossy': { type: 'boolean', default: false },
        capabilities: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`Argument error: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  const file = positionals[1];

  if (values.help || !command) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  try {
    switch (command) {
      case 'validate': {
        if (!file) { io.err('validate requires a file path.\n\n' + USAGE); return 2; }
        const result = parseFormDocument(io.readFile(file));
        if (!result.ok) { printDiagnostics(io, result.diagnostics); return 1; }
        io.out(JSON.stringify({ ok: true, formId: result.document.id, specVersion: result.document.specVersion }, null, 2));
        return 0;
      }

      case 'compile': {
        if (!file) { io.err('compile requires a file path.\n\n' + USAGE); return 2; }
        const parsedDoc = parseFormDocument(io.readFile(file));
        if (!parsedDoc.ok) { printDiagnostics(io, parsedDoc.diagnostics); return 1; }
        let target: RendererCapabilityManifest | undefined;
        if (values.capabilities) target = JSON.parse(io.readFile(values.capabilities)) as RendererCapabilityManifest;
        const result = compileForm(parsedDoc.document, target ? { target } : {});
        if (!result.ok) { printDiagnostics(io, result.diagnostics); return 1; }
        if (values.json) {
          io.out(JSON.stringify(result.ir, null, 2));
        } else {
          io.out(JSON.stringify({
            ok: true, formId: result.ir.formId, formVersion: result.ir.formVersion,
            fieldCount: result.ir.fields.length, fingerprint: result.ir.fingerprint,
            requiredCapabilities: result.ir.requiredCapabilities, warnings: result.warnings,
          }, null, 2));
        }
        return 0;
      }

      case 'inspect': {
        if (!file) { io.err('inspect requires a file path.\n\n' + USAGE); return 2; }
        const parsedDoc = parseFormDocument(io.readFile(file));
        if (!parsedDoc.ok) { printDiagnostics(io, parsedDoc.diagnostics); return 1; }
        const result = compileForm(parsedDoc.document);
        if (!result.ok) { printDiagnostics(io, result.diagnostics); return 1; }
        io.out(JSON.stringify(inspectIR(result.ir), null, 2));
        return 0;
      }

      case 'migrate': {
        if (!file) { io.err('migrate requires a file path.\n\n' + USAGE); return 2; }
        const input = JSON.parse(io.readFile(file));
        const registry = createDefaultMigrationRegistry();
        const result = registry.migrate(input, values.to ?? CURRENT_SPEC_VERSION, { allowLossy: values['allow-lossy'] });
        if (!result.ok) { printDiagnostics(io, result.diagnostics); return 1; }
        io.out(JSON.stringify({ ok: true, applied: result.applied, document: result.document }, null, 2));
        return 0;
      }

      case 'capabilities': {
        io.out(JSON.stringify(genericCapabilityManifest(), null, 2));
        return 0;
      }

      case 'conformance': {
        const report = runConformance();
        if (values.json) {
          io.out(JSON.stringify(report, null, 2));
        } else {
          io.out(`Conformance (spec ${report.specVersion}): ${report.passed}/${report.total} passed, ${report.failed} failed.`);
          for (const r of report.results.filter((x) => !x.passed)) {
            io.err(`  FAIL [${r.suite}] ${r.id}\n    expected: ${JSON.stringify(r.expected)}\n    actual:   ${JSON.stringify(r.actual)}${r.detail ? `\n    detail:   ${r.detail}` : ''}`);
          }
        }
        return report.failed === 0 ? 0 : 1;
      }

      default:
        io.err(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    io.err(`Error: ${(e as Error).message}`);
    return 1;
  }
}
