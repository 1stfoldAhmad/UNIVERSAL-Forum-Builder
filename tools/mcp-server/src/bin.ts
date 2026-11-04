#!/usr/bin/env node
/**
 * Stdio entry point for the VDS Form Builder MCP server.
 * The host grants permissions via VDS_MCP_PERMISSIONS (comma-separated) or
 * --permissions. Defaults to the full form:* set for local development;
 * production hosts should grant the minimal required subset.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFormMcpServer, FORM_MCP_PERMISSIONS } from './index';

function resolvePermissions(argv: string[]): string[] {
  const flagIndex = argv.indexOf('--permissions');
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : process.env.VDS_MCP_PERMISSIONS;
  if (!raw) return [...FORM_MCP_PERMISSIONS];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const server = createFormMcpServer({ grantedPermissions: resolvePermissions(process.argv.slice(2)) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { process.stderr.write(`MCP server error: ${(e as Error).message}\n`); process.exitCode = 1; });
