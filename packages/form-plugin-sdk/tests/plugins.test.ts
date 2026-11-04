import { describe, expect, it } from 'vitest';
import { PluginHost, PLUGIN_CONTRACT_VERSION, RendererComponentRegistry } from '../src/index';
import { createDefaultFieldRegistry } from '@vds-form/fields';
import { SubmissionExecutorRegistry } from '@vds-form/submission';
import { DataSourceProviderRegistry } from '@vds-form/data-sources';
import type { PluginManifest, SubmissionExecutor } from '@vds-form/types';

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'acme-widgets', version: '1.0.0', contractVersion: PLUGIN_CONTRACT_VERSION,
  targets: ['*'], provides: [{ kind: 'field', name: 'acme-rating' }], ...over,
});

const fakeExecutor: SubmissionExecutor = {
  scheme: 'acme', contract: { supportsOfflineQueue: false, idempotent: false, trusted: true },
  supports: () => true,
  execute: async () => ({ status: 'business-rejected', code: 'NOT_USED', message: 'test' }),
};

describe('plugin host', () => {
  it('registers a valid plugin and applies registrations', () => {
    const fields = createDefaultFieldRegistry();
    const host = new PluginHost({ fields });
    const r = host.register(manifest(), { fields: [{
      type: 'acme-rating', valueType: 'integer', emptyValue: null, accepts: ['number', 'null'],
      capability: { fieldType: 'acme-rating', contractVersion: '1.0.0', valueType: 'integer', supportsValidation: true, supportsAsyncValidation: false, supportsAccessibility: true, supportsLocalization: true, supportsReadonly: true, supportsDisabled: true, supportsDynamicOptions: false, requiresNativeModule: false },
    }] });
    expect(r.ok).toBe(true);
    expect(fields.has('acme-rating')).toBe(true);
    expect(host.list().length).toBe(1);
  });

  it('rejects duplicate plugins, incompatible contracts and missing dependencies', () => {
    const host = new PluginHost();
    expect(host.register(manifest()).ok).toBe(true);
    const dup = host.register(manifest());
    expect(dup).toMatchObject({ ok: false, error: { code: 'PLUGIN_DUPLICATE' } });
    const bad = host.register(manifest({ id: 'other', contractVersion: '99.0.0' }));
    expect(bad).toMatchObject({ ok: false, error: { code: 'PLUGIN_CONTRACT_INCOMPATIBLE' } });
    const dep = host.register(manifest({ id: 'needs-dep', dependencies: [{ id: 'missing-lib', versionRange: '^1.0.0' }] }));
    expect(dep).toMatchObject({ ok: false, error: { code: 'PLUGIN_DEPENDENCY_MISSING' } });
  });

  it('rejects undeclared and duplicate registrations', () => {
    const executors = new SubmissionExecutorRegistry();
    const host = new PluginHost({ executors });
    const undeclared = host.register(manifest(), { executors: [fakeExecutor] });
    expect(undeclared).toMatchObject({ ok: false, error: { code: 'PLUGIN_REGISTRATION_UNDECLARED' } });
    const m = manifest({ provides: [{ kind: 'submissionExecutor', name: 'acme' }] });
    expect(host.register(m, { executors: [fakeExecutor] }).ok).toBe(true);
    const host2 = new PluginHost({ executors });
    const dup = host2.register(manifest({ id: 'second', provides: [{ kind: 'submissionExecutor', name: 'acme' }] }), { executors: [fakeExecutor] });
    expect(dup).toMatchObject({ ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE' } });
  });

  it('enforces host-granted permissions (no self-granting)', () => {
    const host = new PluginHost({ grantedPermissions: [] });
    const r = host.register(manifest({ permissions: ['storage:write'] }));
    expect(r).toMatchObject({ ok: false, error: { code: 'PLUGIN_PERMISSION_DENIED' } });
    const host2 = new PluginHost({ grantedPermissions: ['storage:write'] });
    expect(host2.register(manifest({ permissions: ['storage:write'] })).ok).toBe(true);
  });

  it('satisfies semver caret dependencies and target filtering', () => {
    const host = new PluginHost({ target: 'expo' });
    host.register(manifest({ id: 'base-lib', provides: [] }));
    const ok = host.register(manifest({ id: 'consumer', provides: [], dependencies: [{ id: 'base-lib', versionRange: '^1.0.0' }] }));
    expect(ok.ok).toBe(true);
    const wrongTarget = host.register(manifest({ id: 'web-only', targets: ['react'], provides: [] }));
    expect(wrongTarget).toMatchObject({ ok: false, error: { code: 'PLUGIN_CONTRACT_INCOMPATIBLE' } });
  });

  it('registers expression functions into a closed registry', () => {
    const host = new PluginHost();
    const r = host.register(
      manifest({ provides: [{ kind: 'expressionFunction', name: 'double' }] }),
      { expressionFunctions: { double: (args) => typeof args[0] === 'number' ? { ok: true, value: args[0] * 2 } : { ok: false, code: 'EXPR_TYPE_ERROR', message: 'number required' } } },
    );
    expect(r.ok).toBe(true);
    expect(host.getExpressionFunctions().double([21])).toEqual({ ok: true, value: 42 });
  });
});

describe('plugin renderer registration contract', () => {
  const rcManifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
    id: 'acme-renderers', version: '1.0.0', contractVersion: PLUGIN_CONTRACT_VERSION,
    targets: ['*'], provides: [{ kind: 'rendererComponent', name: 'react:acme-rating' }], ...over,
  });

  it('registers, resolves, and revokes custom renderer components', () => {
    const renderers = new RendererComponentRegistry();
    const host = new PluginHost({ renderers, target: 'react' });
    const component = () => null;
    const r = host.register(rcManifest(), { rendererComponents: [{ target: 'react', fieldType: 'acme-rating', component }] });
    expect(r.ok).toBe(true);
    expect(renderers.get('react', 'acme-rating')?.component).toBe(component);
    expect(host.unregister('acme-renderers').ok).toBe(true);
    expect(renderers.has('react', 'acme-rating')).toBe(false);
  });

  it('rejects undeclared, duplicate, wrong-target, and capability-disabled renderer registrations', () => {
    const renderers = new RendererComponentRegistry();
    const host = new PluginHost({ renderers, target: 'react' });
    const component = () => null;
    expect(host.register(rcManifest({ provides: [] }), { rendererComponents: [{ target: 'react', fieldType: 'acme-rating', component }] }))
      .toMatchObject({ ok: false, error: { code: 'PLUGIN_REGISTRATION_UNDECLARED' } });
    expect(host.register(rcManifest(), { rendererComponents: [{ target: 'react', fieldType: 'acme-rating', component }] }).ok).toBe(true);
    expect(host.register(rcManifest({ id: 'second' }), { rendererComponents: [{ target: 'react', fieldType: 'acme-rating', component }] }))
      .toMatchObject({ ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE' } });
    expect(host.register(rcManifest({ id: 'vue-only', provides: [{ kind: 'rendererComponent', name: 'vue:acme-rating' }] }), { rendererComponents: [{ target: 'vue', fieldType: 'acme-rating', component }] }))
      .toMatchObject({ ok: false, error: { code: 'PLUGIN_CONTRACT_INCOMPATIBLE' } });
    const disabled = new PluginHost({ renderers: new RendererComponentRegistry(), capabilities: { rendererComponent: false } });
    expect(disabled.register(rcManifest(), { rendererComponents: [{ target: 'react', fieldType: 'acme-rating', component }] }))
      .toMatchObject({ ok: false, error: { code: 'PLUGIN_CAPABILITY_DENIED' } });
  });

  it('still rejects sandboxed/untrusted manifests for renderer plugins (no isolation claim)', () => {
    const host = new PluginHost({ renderers: new RendererComponentRegistry() });
    expect(host.register(rcManifest({ trust: 'sandboxed' }), { rendererComponents: [{ target: 'react', fieldType: 'acme-rating', component: () => null }] }))
      .toMatchObject({ ok: false, error: { code: 'PLUGIN_SANDBOX_UNSUPPORTED' } });
  });
});
