/**
 * @vds-form/plugins — plugin manifest validation + registration host.
 * Plugins register typed implementations; form JSON never contains plugin code.
 * Duplicate registrations, incompatible contracts and missing dependencies fail closed.
 */
import type {
  DataSourceProvider, PluginManifest, PluginRegistrationKind, SubmissionExecutor,
} from '@vds-form/types';
import type { FieldContract, FieldRegistry } from '@vds-form/fields';
import type { SubmissionExecutorRegistry } from '@vds-form/submission';
import type { DataSourceProviderRegistry } from '@vds-form/data-sources';
import type { EvalResult } from '@vds-form/expressions';

export const PLUGIN_CONTRACT_VERSION = '1.0.0';

export interface PluginRegistrations {
  fields?: FieldContract[];
  executors?: SubmissionExecutor[];
  dataProviders?: DataSourceProvider[];
  expressionFunctions?: Record<string, (args: unknown[]) => EvalResult>;
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
  | { code: 'PLUGIN_REGISTRATION_DUPLICATE'; message: string }
  | { code: 'PLUGIN_REGISTRATION_UNDECLARED'; message: string }
  | { code: 'PLUGIN_PERMISSION_DENIED'; message: string };

export interface PluginHostOptions {
  fields?: FieldRegistry;
  executors?: SubmissionExecutorRegistry;
  dataProviders?: DataSourceProviderRegistry;
  /** Permissions granted by the host (plugins never self-grant). */
  grantedPermissions?: string[];
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

export class PluginHost {
  private plugins = new Map<string, RegisteredPlugin>();
  private expressionFunctions: Record<string, (args: unknown[]) => EvalResult> = {};

  constructor(private options: PluginHostOptions = {}) {}

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
    const granted = new Set(this.options.grantedPermissions ?? []);
    for (const perm of manifest.permissions ?? []) {
      if (!granted.has(perm)) {
        return { ok: false, error: { code: 'PLUGIN_PERMISSION_DENIED', message: `Permission "${perm}" not granted by host.` } };
      }
    }
    const declared = new Set(manifest.provides.map((p) => `${p.kind}:${p.name}`));
    const checkDeclared = (kind: PluginRegistrationKind, name: string): PluginError | null =>
      declared.has(`${kind}:${name}`) ? null : { code: 'PLUGIN_REGISTRATION_UNDECLARED', message: `${kind} "${name}" not declared in manifest.provides.` };

    for (const f of registrations.fields ?? []) {
      const un = checkDeclared('field', f.type);
      if (un) return { ok: false, error: un };
      if (this.options.fields?.has(f.type)) {
        return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: `Field type "${f.type}" already registered.` } };
      }
    }
    for (const e of registrations.executors ?? []) {
      const un = checkDeclared('submissionExecutor', e.scheme);
      if (un) return { ok: false, error: un };
      if (this.options.executors?.get(e.scheme)) {
        return { ok: false, error: { code: 'PLUGIN_REGISTRATION_DUPLICATE', message: `Executor scheme "${e.scheme}" already registered.` } };
      }
    }
    for (const p of registrations.dataProviders ?? []) {
      const un = checkDeclared('dataSourceProvider', p.scheme);
      if (un) return { ok: false, error: un };
      if (this.options.dataProviders?.get(p.scheme)) {
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

    // Apply (all checks passed).
    for (const f of registrations.fields ?? []) this.options.fields?.register(f);
    for (const e of registrations.executors ?? []) this.options.executors?.register(e);
    for (const p of registrations.dataProviders ?? []) this.options.dataProviders?.register(p);
    Object.assign(this.expressionFunctions, registrations.expressionFunctions ?? {});
    this.plugins.set(manifest.id, { manifest, registrations });
    return { ok: true };
  }

  list(): PluginManifest[] { return [...this.plugins.values()].map((p) => p.manifest); }
  getExpressionFunctions(): Record<string, (args: unknown[]) => EvalResult> { return { ...this.expressionFunctions }; }
}
