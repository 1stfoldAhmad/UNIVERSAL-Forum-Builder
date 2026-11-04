import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFormMcpServer, FORM_MCP_PERMISSIONS } from '../src/index';

const contact = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'contact.vds.json'), 'utf8'));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function connect(grantedPermissions: string[]) {
  const server = createFormMcpServer({ grantedPermissions });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

const parse = (result: unknown) =>
  JSON.parse(((result as { content: Array<{ type: string; text?: string }> }).content).find((c) => c.type === 'text')!.text!);

describe('MCP server (permission-gated form tools)', () => {
  it('lists all six tools', async () => {
    const client = await connect([...FORM_MCP_PERMISSIONS]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['compile_form', 'inspect_form', 'list_capabilities', 'migrate_form', 'run_conformance', 'validate_form']);
  });

  it('fail-closed: no grants → every tool denied, nothing executes', async () => {
    const client = await connect([]);
    const result = await client.callTool({ name: 'validate_form', arguments: { document: contact } });
    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.code).toBe('MCP_PERMISSION_DENIED');
    expect(body.message).toContain('form:validate');
  });

  it('grants only the requested permission (others still denied)', async () => {
    const client = await connect(['form:validate']);
    const ok = await client.callTool({ name: 'validate_form', arguments: { document: contact } });
    expect(ok.isError).toBeFalsy();
    expect(parse(ok).formId).toBe('contact');
    const denied = await client.callTool({ name: 'compile_form', arguments: { document: contact } });
    expect(denied.isError).toBe(true);
    expect(parse(denied).code).toBe('MCP_PERMISSION_DENIED');
  });

  it('validate_form accepts a canonical document and rejects a bad one', async () => {
    const client = await connect(['form:validate']);
    const good = parse(await client.callTool({ name: 'validate_form', arguments: { document: contact } }));
    expect(good.ok).toBe(true);
    const bad = await client.callTool({ name: 'validate_form', arguments: { document: { format: 'vds.form', specVersion: '0.0.1' } } });
    expect(bad.isError).toBe(true);
    expect(parse(bad).diagnostics.length).toBeGreaterThan(0);
  });

  it('compile_form returns FormIR with a fingerprint', async () => {
    const client = await connect(['form:compile']);
    const body = parse(await client.callTool({ name: 'compile_form', arguments: { document: contact } }));
    expect(body.ok).toBe(true);
    expect(body.ir.fingerprint).toBeTruthy();
    expect(body.fieldCount).toBe(3);
  });

  it('inspect_form returns operation references', async () => {
    const client = await connect(['form:inspect']);
    const body = parse(await client.callTool({ name: 'inspect_form', arguments: { document: contact } }));
    expect(body.inspection.operationReferences.submission).toBe('test:contact.create');
  });

  it('migrate_form upgrades a 0.9.0 document', async () => {
    const client = await connect(['form:migrate']);
    const old = { format: 'vds.form', specVersion: '0.9.0', id: 'legacy', metadata: { name: 'Legacy', version: '1.0.0' }, fields: [{ id: 'name', type: 'text', name: 'name', label: 'Name' }], submit: { operation: 'test:save' } };
    const body = parse(await client.callTool({ name: 'migrate_form', arguments: { document: old, targetVersion: '1.0.0' } }));
    expect(body.ok).toBe(true);
    expect(body.document.specVersion).toBe('1.0.0');
  });

  it('list_capabilities returns the field manifest', async () => {
    const client = await connect(['form:capabilities']);
    const body = parse(await client.callTool({ name: 'list_capabilities', arguments: {} }));
    expect(body.manifest.fieldTypes.text).toBeTruthy();
  });

  it('run_conformance reports a green suite', async () => {
    const client = await connect(['form:conformance']);
    const result = await client.callTool({ name: 'run_conformance', arguments: {} });
    expect(result.isError).toBeFalsy();
    const body = parse(result);
    expect(body.failed).toBe(0);
    expect(body.total).toBeGreaterThan(50);
  });

  it('accepts a document passed as a JSON string', async () => {
    const client = await connect(['form:validate']);
    const body = parse(await client.callTool({ name: 'validate_form', arguments: { document: JSON.stringify(contact) } }));
    expect(body.ok).toBe(true);
    expect(body.formId).toBe('contact');
  });
});

describe('MCP migration input diagnostics', () => {
  it('denies migrate without form:migrate permission', async () => {
    const client = await connect([]);
    const result = await client.callTool({ name: 'migrate_form', arguments: { document: contact } });
    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe('MCP_PERMISSION_DENIED');
  });

  it('returns structured diagnostics for malformed JSON migration input', async () => {
    const client = await connect(['form:migrate']);
    const result = await client.callTool({ name: 'migrate_form', arguments: { document: '{bad json' } });
    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0].code).toBe('MCP_INPUT_INVALID');
  });

  it('returns structured diagnostics for non-object migration input', async () => {
    const client = await connect(['form:migrate']);
    const result = await client.callTool({ name: 'migrate_form', arguments: { document: '[]' } });
    expect(result.isError).toBe(true);
    expect(parse(result).diagnostics[0].code).toBe('MCP_INPUT_INVALID');
  });
});
