import { describe, expect, it } from 'vitest';
import { LogicEngine, createVdsExecutors, mapExecutionResult } from '../src/index';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import { FormController } from '@vds-form/runtime';
import { compileForm } from '@vds-form/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SubmissionContext } from '@vds-form/types';

/**
 * These tests run against the REAL vds-json-logic engine built from source
 * (vendor/vds-json-logic). Specs below use the engine's actual envelope format.
 */
const bundle = {
  functions: [
    {
      id: 'function.customer.create', name: 'createCustomer', type: 'function', version: '1.0.0', spec_version: '1.0.0',
      execution: { target: 'backend', mode: 'async', capabilities: ['database:write'] },
      definition: {
        kind: 'native', native: 'customerCreate',
        parameters: [
          { name: 'name', type: 'string', required: true },
          { name: 'email', type: 'string', required: true },
        ],
        return: { name: 'record', type: 'object' },
      },
    },
    {
      id: 'function.customer.validate', name: 'validateCustomer', type: 'function', version: '1.0.0', spec_version: '1.0.0',
      execution: { target: 'shared', mode: 'sync' },
      definition: {
        kind: 'predicate',
        parameters: [{ name: 'email', type: 'string', required: true }],
        return: { name: 'valid', type: 'boolean' },
        expression: { operator: 'matches', arguments: ['$.email', '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'] },
      },
    },
  ],
  flows: [
    {
      id: 'flow.purchase.approval', name: 'purchaseApproval', type: 'flow', version: '1.0.0', spec_version: '1.0.0',
      execution: { target: 'shared', mode: 'async' },
      definition: {
        parameters: [
          { name: 'amount', type: 'number', required: true },
          { name: 'item', type: 'string', required: true },
        ],
        returns: { name: 'result', type: 'object' },
        nodes: [
          { id: 'start', type: 'start', next: 'check' },
          {
            id: 'check', type: 'if',
            condition: { operator: 'gt', arguments: ['$.amount', 10000] },
            then: [{ id: 'reject', type: 'throw', error: { code: 'VALIDATION_FAILED', message: 'Amount exceeds approval limit', details: { field: 'amount' } } }],
            else: [],
            next: 'approve',
          },
          { id: 'approve', type: 'set', assignments: { status: 'approved', amount: '$.amount' }, next: 'done' },
          { id: 'done', type: 'return', value: { status: '$.status', amount: '$.amount', item: '$.item' } },
        ],
      },
    },
  ],
};

function makeEngine(): LogicEngine {
  const engine = new LogicEngine({ environment: 'backend', capabilities: ['database:write'] });
  engine.loadJson(bundle);
  const records: Array<Record<string, unknown>> = [];
  engine.registerNative('customerCreate', async (args) => {
    const record = { id: `cust-${records.length + 1}`, ...args };
    records.push(record);
    return record;
  }, { capabilities: ['database:write'] });
  return engine;
}

const ctx = (values: Record<string, unknown>): SubmissionContext => ({
  formId: 'customer-registration', formVersion: '1.2.0', specVersion: '1.0.0',
  values, idempotencyKey: 'key-1', correlationId: 'corr-1',
  authenticatedContext: { userId: 'u1', tenantId: 't1', roles: ['admin'], permissions: ['customer:create'] },
});

describe('REAL vds-json-logic integration', () => {
  it('logic: executor calls a real JSON-defined native function and persists', async () => {
    const engine = makeEngine();
    const { logic } = createVdsExecutors(engine);
    expect(logic.supports({ operationRef: 'logic:function.customer.create' })).toBe(true);
    expect(logic.supports({ operationRef: 'logic:function.missing' })).toBe(false);
    const result = await logic.execute({ operationRef: 'logic:function.customer.create' }, ctx({ name: 'Ada', email: 'ada@example.com' }));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect((result.data as { id: string }).id).toBe('cust-1');
      expect(result.executionId).toBeTruthy();
    }
    engine.dispose();
  });

  it('pure JSON predicate function executes with real expression evaluation', async () => {
    const engine = makeEngine();
    const { logic } = createVdsExecutors(engine);
    const ok = await logic.execute({ operationRef: 'logic:function.customer.validate' }, ctx({ email: 'ada@example.com' }));
    expect(ok.status).toBe('succeeded');
    if (ok.status === 'succeeded') expect(ok.data).toBe(true);
    const bad = await logic.execute({ operationRef: 'logic:function.customer.validate' }, ctx({ email: 'not-an-email' }));
    expect(bad.status).toBe('succeeded');
    if (bad.status === 'succeeded') expect(bad.data).toBe(false);
    engine.dispose();
  });

  it('workflow: executor runs a real flow (set/if/end nodes)', async () => {
    const engine = makeEngine();
    const { workflow } = createVdsExecutors(engine);
    expect(workflow.supports({ operationRef: 'workflow:flow.purchase.approval' })).toBe(true);
    const result = await workflow.execute({ operationRef: 'workflow:flow.purchase.approval' }, ctx({ amount: 1500, item: 'Laptop' }));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.data).toMatchObject({ status: 'approved', amount: 1500, item: 'Laptop' });
    }
    engine.dispose();
  });

  it('flow throw node maps VALIDATION_FAILED to server-validation-failed', async () => {
    const engine = makeEngine();
    const { workflow } = createVdsExecutors(engine);
    const result = await workflow.execute({ operationRef: 'workflow:flow.purchase.approval' }, ctx({ amount: 50000, item: 'Server rack' }));
    expect(result.status).toBe('server-validation-failed');
    if (result.status === 'server-validation-failed') {
      expect(result.issues[0].code).toBe('VALIDATION_FAILED');
      expect(result.issues[0].path).toBe('amount');
    }
    engine.dispose();
  });

  it('missing parameter → PARAM_INVALID mapped to server validation failure', async () => {
    const engine = makeEngine();
    const { logic } = createVdsExecutors(engine);
    const result = await logic.execute({ operationRef: 'logic:function.customer.create' }, ctx({ name: 'NoEmail' }));
    expect(result.status).toBe('server-validation-failed');
    engine.dispose();
  });

  it('end-to-end: FormController submits through the real logic engine', async () => {
    const engine = makeEngine();
    const { logic, workflow } = createVdsExecutors(engine);
    const doc = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'customer-registration.vds.json'), 'utf8'));
    doc.submission.operationRef = 'logic:function.customer.create';
    doc.submission.inputMapping = { name: 'customer.name', email: 'customer.email' };
    const compiled = compileForm(doc);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const executors = new SubmissionExecutorRegistry();
    executors.register(logic);
    executors.register(workflow);
    const controller = new FormController({ ir: compiled.ir, executors });
    await controller.initialize();
    controller.setFieldValue('customer.name', 'Grace Hopper');
    controller.setFieldValue('customer.email', 'grace@example.com');
    controller.setFieldValue('customer.consent', true);
    const result = await controller.submit();
    expect(result.status).toBe('succeeded');
    expect(controller.getState()).toBe('submission-succeeded');
    if (result.status === 'succeeded') {
      expect(result.data).toMatchObject({ name: 'Grace Hopper', email: 'grace@example.com' });
    }
    controller.dispose();
    engine.dispose();
  });

  it('error-code mapping is exhaustive for the engine contract', () => {
    const contract = { supportsOfflineQueue: false, idempotent: false, trusted: true };
    const mk = (code: string) => mapExecutionResult(
      { success: false, error: { code, message: code }, executionId: 'e', duration: 1 },
      'logic:x', 'k', contract,
    );
    expect(mk('NOT_ALLOWED').status).toBe('permission-denied');
    expect(mk('EXEC_CANCELLED').status).toBe('cancelled');
    expect(mk('EXEC_TIMEOUT').status).toBe('network-failure');
    expect(mk('REF_NOT_FOUND').status).toBe('config-error');
    expect(mk('FLOW_ERROR').status).toBe('business-rejected');
  });
});
