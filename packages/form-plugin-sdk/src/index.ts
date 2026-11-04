/**
 * @vds-form/plugins — plugin manifest validation + registration host.
 * Plugins register typed implementations; form JSON never contains plugin code.
 * Duplicate registrations, incompatible contracts and missing dependencies fail closed.
 *
 * TRUST BOUNDARY: this host has NO sandbox. `trust: 'sandboxed' | 'untrusted'`
 * is rejected until a real isolation adapter exists. Host-registered trusted
 * code is distinguished from rejected sandboxed manifests, and registrations
 * can be revoked with dependency-aware cleanup.
 */
import type {
  DataSourceProvider, PluginManifest, PluginRegistrationKind, SubmissionExecutor,
} from '@vds-form/types';
import type { FieldContract, FieldRegistry } from '@vds-form/fields';
import type { SubmissionExecutorRegistry } from '@vds-form/submission';
import type { DataSourceProviderRegistry } from '@vds-form/data-sources';
import type { EvalResult } from '@vds-form/expressions';

export const PLUGIN_CONTRACT_VERSION = '1.0.0';

/** Platform-specific renderer component registration. `component` is opaque to
 * the plugin host (React/Vue/Angular/Expo component); the target renderer owns
 * how it is mounted. Manifest name convention: `${target}:${fieldType}`. */
export interface RendererComponentRegistration {
  target: string;
  fieldType: string;
  component: unknown;
}

/** Closed registry for custom plugin field renderers. Registration does NOT
 * advertise renderer capabilities or imply sandbox isolation; hosts still
 * negotiate capabilities and only trusted code is accepted. */
export class RendererComponentRegistry {
  private components = new Map<string, RendererComponentRegistration>();
  private key(target: string, fieldType: string) { return `${target}:${fieldType}`; }
  register(reg: RendererComponentRegistration): void {
    if (!reg.target || !reg.fieldType) throw new Error('RENDERER_REGISTRATION_INVALID: target and fieldType are required.');
    if (reg.component === null || reg.component === undefined) throw new Error('RENDERER_REGISTRATION_INVALID: component is required.');
    const key = this.key(reg.target, reg.fieldType);
    if (this.components.has(key)) throw new Error(`RENDERER_REGISTRATION_DUPLICATE: ${key} already registered.`);
    this.components.set(key, { ...reg });
  }
  unregister(target: string, fieldType: string): boolean { return this.components.delete(this.key(target, fieldType)); }
  get(target: string, fieldType: string): RendererComponentRegistration | undefined {
    return this.components.get(this.key(target, fieldType)) ?? this.components.get(this.key('*', fieldType));
  }
  has(target: string, fieldType: string): boolean { return this.get(target, fieldType) !== undefined; }
  list(): RendererComponentRegistration[] { return [...this.components.values()].map((r) => ({ ...r })); }
}

export interface PluginRegistrations {
  fields?: FieldContract[];
  executors?: SubmissionExecutor[];
  dataProviders?: DataSourceProvider[];
  expressionFunctions?: Record<string, (args: unknown[]) => EvalResult>;
  rendererComponents?: RendererComponentRegistration[];
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  registrations: PluginRegistrations;
}

export type PluginError =
  | { code: 'PLUGIN_MANIFEST_INVALID'; message: string }
  | { code: 'PLUGIN_CONTRACT_INCOMPATIBLE'; message: string }
  | { code: 'PLUGIN_DUPLICATE'; message: string }
  | { code: 'PLUGIN_DEPENDENCY_MISSING'; message: string }
  | { code: 'PLUGIN_DEPENDENCY_ACTIVE'; message: string }
  | { code: 'PLUGIN_REGISTRATION_DUPLICATE'; message: string }
  | { code: 'PLUGIN_REGISTRATION_UNDECLARED'; message: string }
  | { code: 'PLUGIN_PERMISSION_DENIED'; message: string }
  | { code: 'PLUGIN_SANDBOX_UNSUPPORTED'; message: string }
  | { code: 'PLUGIN_CAPABILITY_DENIED'; message: string }
  | { code: 'PLUGIN_REGISTRY_MISSING'; message: string }
  | { code: 'PLUGIN_NOT_FOUND'; message: string };

export interface PluginHostOptions {
  fields?: FieldRegistry;
  executors?: SubmissionExecutorRegistry;
  dataProviders?: DataSourceProviderRegistry;
  renderers?: RendererComponentRegistry;
  /** Permissions granted by the host (plugins never self-grant). */
  grantedPermissions?: string[];
  /** Optional per-plugin grants. When present for a plugin id, these replace
   * the global grants for that plugin (least privilege per plugin). */
  pluginPermissions?: Record<string, string[]>;
  /** Capability allowlist by registration kind. Defaults to all enabled. */
  capabilities?: Partial<Record<PluginRegistrationKind, boolean>>;
  target?: string;
}

function satisfies(version: string, range: string): boolean {
  if (range === '*' || range === version) return true;
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) return false;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!v) return false;
  const [vmaj, vmin, vpat] = [Number(v[1]), Number(v[2]), Number(v[3])];
  if (vmaj !== maj) return false;
  return vmin > min || (vmin === min && vpat >= pat);
}

const cloneManifest = (m: PluginManifest): PluginManifest => ({
  ...m,
  trust: m.trust ?? 'trusted',
  targets: [...m.targets],
  provides: m.provides.map((p) => ({ ...p })),
  dependencies: m.dependencies?.map((d) => ({ ...d })),
  permissions: m.permissions ? [...m.permissions] : undefined,
});

export class PluginHost {
  private plugins = new Map<string, RegisteredPlugin>();
  private expressionFunctions: Record<string, (args: unknown[]) => EvalResult> = {};

  constructor(private options: PluginHostOptions = {}) {}

  private capabilityEnabled(kind: PluginRegistrationKind): boolean {
    return this.options.capabilities?.[kind] !== false;
  }

  register(manifest: PluginManifest, registrations: PluginRegistrations = {}): { ok: true } | { ok: false; error: PluginError } {
    if (!manifest.id || !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(manifest.id)) {
      return { ok: false, error: { code: 'PLUGIN_MANIFEST_INVALID', message: 'Plugin id must be kebab-case.' } };
    }
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      return { ok: false, error: { code: 'PLUGIN_MANIFEST_INVALID', message: 'Plugin version must be semver.' } };
    }
    if (manifest.contractVersion !== PLUGIN_CONTRACT_VERSION) {
      return { ok: false, error: { code: 'PLUGIN_CONTRACT_INCOMPATIBLE', message: `Plugin contract ${manifest.contractVersion} ≠ host ${PLUGIN_CONTRACT_VERSION}.` } };
    }
    if (manifest.trust === 'sandboxed' || manifest.trust === 'untrusted') {
      return { ok: false, error: { code: 'PLUGIN_SANDBOX_UNSUPPORTED', message: 'Sandboxed/untrusted plugins are rejected: no isolation adapter is implemented. Register only trusted host code.' } };
    }
    if (manifest.trust !== undefined && manifest.trust !== 'trusted') {
      return { ok: false, error: { code: 'PLUGIN_MANIFEST_INVALID', message: `Unknown plugin trust "${String(manifest.trust)}".` } };
    }
    if (this.plugins.has(manifest.id)) {
      return { ok: false, error: { code: 'PLUGIN_DUPLICATE', message: `Plugin "${manifest.id}" already registered.` } };
    }
    if (this.options.target && manifest.targets.length && !manifest.targets.includes(this.options.target) && !manifest.targets.includes('*')) {
      return { ok: false, error: { code: 'PLUGIN_CONTRACT_INCOMPATIBLE', message: `Plugin does not target "${this.options.target}".` } };
    }
    for (const dep of manifest.dependencies ?? []) {
      const found = this.plugins.get(dep.id);
      if (!found || !satisfies(found.manifest.version, dep.versionRange)) {
        return { ok: false, error: { code: 'PLUGIN_DEPENDENCY_MISSING', message: `Dependency "${dep.id}@${dep.versionRange}" not satisfied.` } };
      }
    }
    const grants = this.options.pluginPermissions?.[manifest.id] ?? this.options.grantedPermissions ?? [];
    const granted = new Set(grants);
    for (const perm of manifest.permissions ?? []) {
      if (!granted.has(perm)) {
        return { ok: false, error: { code: 'PLUGIN_PERMISSION_DENIED', message: `Permission "${perm}" not granted by host.` } };
      }
    }
    for (const p of manifest.provides) {
      if (!this.capabilityEnabled(p.kind)) {
        return { ok: false, error: { code: 'PLUGIN_CAPABILITY_DENIED', message: `Registration kind "${p.kind}" is disabled by host capabilities.` } };
      }
    }
    const declared = new Set(manifest.provides.map((p) => `${p.kind}:${p.name}`));
    const checkDeclared = (kind: PluginRegistrationKind, name: string): PluginError | null =>
      declared.has(`${kind}:${name}`) ? null : { code: 'PLUGIN_REGISTRATION_UNDECLARED', message: `${kind} "${name}" not declared in manifest.provides.` };

    for (const f of registrations.fields ?? []) {
      const un = checkDeclared('field', f.type);
      if (un) return { ok: false, error: un };
      if (!this.options.fields) return { ok: false, error: { code: 'PLUGIN_REGISTRY_MISSING', message: 'Field registrations require a FieldRegistry.' } };
      if (this.options.fields.has(f.type)) {
        return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: `Field type "${f.type}" already registered.` } };
      }
    }
    for (const e of registrations.executors ?? []) {
      const un = checkDeclared('submissionExecutor', e.scheme);
      if (un) return { ok: false, error: un };
      if (!this.options.executors) return { ok: false, error: { code: 'PLUGIN_REGISTRY_MISSING', message: 'Executor registrations require a SubmissionExecutorRegistry.' } };
      if (this.options.executors.get(e.scheme)) {
        return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: `Executor scheme "${e.scheme}" already registered.` } };
      }
    }
    for (const p of registrations.dataProviders ?? []) {
      const un = checkDeclared('dataSourceProvider', p.scheme);
      if (un) return { ok: false, error: un };
      if (!this.options.dataProviders) return { ok: false, error: { code: 'PLUGIN_REGISTRY_MISSING', message: 'Data provider registrations require a DataSourceProviderRegistry.' } };
      if (this.options.dataProviders.get(p.scheme)) {
        return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: `Provider scheme "${p.scheme}" already registered.` } };
      }
    }
    for (const name of Object.keys(registrations.expressionFunctions ?? {})) {
      const un = checkDeclared('expressionFunction', name);
      if (un) return { ok: false, error: un };
      if (Object.hasOwn(this.expressionFunctions, name)) {
        return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: `Expression function "${name}" already registered.` } };
      }
    }
    for (const rc of registrations.rendererComponents ?? []) {
      const un = checkDeclared('rendererComponent', `${rc.target}:${rc.fieldType}`);
      if (un) return { ok: false, error: un };
      if (!this.options.renderers) return { ok: false, error: { code: 'PLUGIN_REGISTRY_MISSING', message: 'Renderer registrations require a RendererComponentRegistry.' } };
      if (this.options.target && rc.target !== '*' && rc.target !== this.options.target) {
        return { ok: false, error: { code: 'PLUGIN_CONTRACT_INCOMPATIBLE', message: `Renderer component targets "${rc.target}", host target is "${this.options.target}".` } };
      }
      if (this.options.renderers.has(rc.target, rc.fieldType)) {
        return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: `Renderer component "${rc.target}:${rc.fieldType}" already registered.` } };
      }
    }

    // Apply transactionally; rollback on any registry failure.
    const undo: Array<() => void> = [];
    try {
      for (const f of registrations.fields ?? []) {
        this.options.fields!.register(f);
        undo.push(() => this.options.fields!.unregister(f.type));
      }
      for (const e of registrations.executors ?? []) {
        this.options.executors!.register(e);
        undo.push(() => this.options.executors!.unregister(e.scheme));
      }
      for (const p of registrations.dataProviders ?? []) {
        this.options.dataProviders!.register(p);
        undo.push(() => this.options.dataProviders!.unregister(p.scheme));
      }
      for (const [name, fn] of Object.entries(registrations.expressionFunctions ?? {})) {
        this.expressionFunctions[name] = fn;
        undo.push(() => { delete this.expressionFunctions[name]; });
      }
      for (const rc of registrations.rendererComponents ?? []) {
        this.options.renderers!.register(rc);
        undo.push(() => this.options.renderers!.unregister(rc.target, rc.fieldType));
      }
    } catch (e) {
      for (const u of undo.reverse()) u();
      return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: e instanceof Error ? e.message : String(e) } };
    }
    this.plugins.set(manifest.id, { manifest: cloneManifest(manifest), registrations });
    return { ok: true };
  }

  /** Revoke a plugin and remove every registration it contributed. Fails when
   * active dependents exist unless `cascade` is true. */
  unregister(pluginId: string, opts: { cascade?: boolean } = {}): { ok: true; removed: string[] } | { ok: false; error: PluginError } {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return { ok: false, error: { code: 'PLUGIN_NOT_FOUND', message: `Plugin "${pluginId}" is not registered.` } };
    const order: string[] = [];
    const visit = (id: string, seen: Set<string>): PluginError | null => {
      if (seen.has(id)) return null;
      seen.add(id);
      const dependents = [...this.plugins.values()].filter((p) => (p.manifest.dependencies ?? []).some((d) => d.id === id));
      if (dependents.length && !opts.cascade) {
        return { code: 'PLUGIN_DEPENDENCY_ACTIVE', message: `Plugin "${id}" has active dependents: ${dependents.map((d) => d.manifest.id).join(', ')}.` };
      }
      for (const d of dependents) {
        const err = visit(d.manifest.id, seen);
        if (err) return err;
      }
      order.push(id);
      return null;
    };
    const err = visit(pluginId, new Set());
    if (err) return { ok: false, error: err };
    for (const id of order) {
      const p = this.plugins.get(id);
      if (!p) continue;
      for (const f of p.registrations.fields ?? []) this.options.fields?.unregister(f.type);
      for (const e of p.registrations.executors ?? []) this.options.executors?.unregister(e.scheme);
      for (const dp of p.registrations.dataProviders ?? []) this.options.dataProviders?.unregister(dp.scheme);
      for (const name of Object.keys(p.registrations.expressionFunctions ?? {})) delete this.expressionFunctions[name];
      for (const rc of p.registrations.rendererComponents ?? []) this.options.renderers?.unregister(rc.target, rc.fieldType);
      this.plugins.delete(id);
    }
    return { ok: true, removed: order };
  }

  list(): PluginManifest[] { return [...this.plugins.values()].map((p) => cloneManifest(p.manifest)); }
  getExpressionFunctions(): Record<string, (args: unknown[]) => EvalResult> { return { ...this.expressionFunctions }; }
}
