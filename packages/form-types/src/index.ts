/**
 * @vds-form/types — canonical contracts for the VDS Universal Form Standard.
 * Platform-independent: no UI framework, no Node-only APIs.
 */

export const FORMAT_ID = 'vds.form';
export const SPEC_VERSION = '1.0.0';
export const IR_VERSION = '1.0.0';
export const EXPR_LANGUAGE = 'vds.expr/1';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type FormValues = Record<string, unknown>;
export type LocalizedText = string | Record<string, string>;

/* ------------------------------------------------------------------ */
/* Expression AST (vds.expr/1) — the cross-language logic contract     */
/* ------------------------------------------------------------------ */

export interface ConstExpr { const: JsonValue }
/** ref grammar: `field:<keyPath>` | `context:<key>` | `item:<path>` | `parent:<path>` | `index` | `source:<id>` */
export interface RefExpr { ref: string }
export interface OpExpr { op: string; args: Expr[] }
export type Expr = ConstExpr | RefExpr | OpExpr;

export type RefKind = 'field' | 'context' | 'item' | 'parent' | 'index' | 'source';
export interface ParsedRef { kind: RefKind; path: string }

/* ------------------------------------------------------------------ */
/* Document                                                           */
/* ------------------------------------------------------------------ */

export type ValueType =
  | 'string' | 'number' | 'integer' | 'boolean'
  | 'string[]' | 'number[]' | 'object' | 'object[]'
  | 'asset' | 'asset[]' | 'null';

export interface FieldOption { value: string | number | boolean; label: LocalizedText }

export interface FieldValidation {
  minLength?: number; maxLength?: number;
  min?: number; max?: number;
  minItems?: number; maxItems?: number;
  pattern?: string;
  format?: 'email' | 'url' | 'phone' | 'date' | 'time' | 'date-time' | 'uuid' | 'postal-code' | 'color' | 'barcode';
  precision?: number;
  accept?: string[];            // MIME types / extensions for asset fields
  maxSizeBytes?: number;
  multiple?: boolean;
  message?: LocalizedText;      // override for the primary built-in rule
}

export interface FieldDef {
  id: string;
  type: string;
  /** Stable data path. Repeater children use `items[].qty` syntax. */
  key: string;
  label?: LocalizedText;
  description?: LocalizedText;
  defaultValue?: JsonValue;
  valueType?: ValueType;
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  options?: FieldOption[] | { sourceId: string; valueKey?: string; labelKey?: string };
  validation?: FieldValidation;
  /** Marks a value produced by a formula (read-only output). */
  computed?: boolean;
  ui?: { placeholder?: LocalizedText; helpText?: LocalizedText; widget?: string; width?: 'full' | 'half'; rows?: number };
  accessibility?: { hint?: LocalizedText; role?: string };
  extensions?: Record<string, JsonValue>;
  /** For `group` (object) and `repeater` (object[]) fields. */
  children?: FieldDef[];
  /** Repeater bounds. */
  minItems?: number; maxItems?: number;
}

export interface ConditionEffect {
  fieldId: string;
  set: { visible?: boolean; required?: boolean; disabled?: boolean; readonly?: boolean };
}
export interface ConditionDef { id: string; when: Expr; effects: ConditionEffect[] }
export interface FormulaDef {
  id: string;
  /** Target key path; `items[].total` targets each repeater row. */
  target: string;
  expr: Expr;
}
export interface CrossFieldRule {
  id: string; expr: Expr; message: LocalizedText;
  path?: string; severity?: 'error' | 'warning';
}
export interface AsyncValidationRule {
  id: string;
  /** Key path whose value is checked remotely. */
  path: string;
  /** Registered data-source/API operation, e.g. `api:user.checkUnique`. Never a URL. */
  operationRef: string;
  inputMapping?: Record<string, string>;
  debounceMs?: number; timeoutMs?: number;
  message: LocalizedText;
}

export interface DataSourceDef {
  id: string;
  /** Registered provider operation reference, e.g. `api:geo.countries`. Never a URL/credential. */
  providerRef: string;
  params?: Record<string, JsonValue | Expr>;
  cache?: { ttlMs: number };
}

export type LayoutNodeType =
  | 'section' | 'group' | 'row' | 'columns' | 'tabs' | 'tab' | 'accordion'
  | 'steps' | 'step' | 'fieldset' | 'summary' | 'repeater' | 'divider' | 'text';

export interface LayoutNode {
  type: LayoutNodeType;
  id?: string;
  title?: LocalizedText;
  text?: LocalizedText;
  /** Field ids placed here (leaf placement). */
  fieldRefs?: string[];
  /** For `repeater` nodes: the repeater field id whose rows render `children`. */
  repeaterRef?: string;
  children?: LayoutNode[];
}

/**
 * Typed contract for operation-specific inputs that are NOT form fields.
 * Unknown properties are rejected by default; set additionalProperties=true
 * only for an explicitly documented open object. Recursive object/array shapes
 * are declared with properties/items.
 */
export interface OperationInputDef {
  valueType: ValueType;
  required?: boolean;
  properties?: Record<string, OperationInputDef>;
  items?: OperationInputDef;
  additionalProperties?: boolean;
}

export interface SuccessHookDef {
  operationRef: string;
  inputMapping?: Record<string, string>;
  condition?: Expr;
  /** Typed non-field inputs accepted by the hook operation. */
  operationInputs?: Record<string, OperationInputDef>;
}

export interface SubmissionDef {
  operationRef: string;
  operationVersion?: string;
  /** targetParam -> source key path. Default: identity of visible values. */
  inputMapping?: Record<string, string>;
  /** Typed non-field inputs accepted by the submission operation. */
  operationInputs?: Record<string, OperationInputDef>;
  includeHidden?: boolean;
  idempotency?: { strategy: 'auto' | 'stable'; stableKeys?: string[] };
  offline?: { queue: boolean };
  /** Post-success operations executed through registered executors (workflow:/notification:). */
  onSuccess?: SuccessHookDef[];
}

export interface PersistenceDef {
  drafts?: {
    enabled: boolean;
    scope?: 'user' | 'tenant' | 'device';
    ttlSeconds?: number;
    /** Explicit opt-in to persist registry-sensitive fields (passwords/tokens).
     * Default false: sensitive values are stripped before draft storage. */
    includeSensitive?: boolean;
  };
  offline?: {
    enabled: boolean;
    /** Explicit opt-in to queue registry-sensitive fields. Default false.
     * Queues are durable and may outlive the session; prefer re-authentication. */
    includeSensitive?: boolean;
  };
}

export interface SecurityDef {
  submitPermissions?: string[];
  fieldAccess?: Record<string, { read?: string[]; write?: string[] }>;
}

export interface FormDocument {
  format: typeof FORMAT_ID;
  specVersion: string;
  id: string;
  metadata: { name: LocalizedText; description?: LocalizedText; version?: string };
  model?: { entityRef?: string };
  fields: FieldDef[];
  layout?: LayoutNode;
  logic?: { conditions?: ConditionDef[]; formulas?: FormulaDef[] };
  validation?: { crossField?: CrossFieldRule[]; async?: AsyncValidationRule[] };
  dataSources?: DataSourceDef[];
  submission?: SubmissionDef;
  persistence?: PersistenceDef;
  security?: SecurityDef;
  localization?: { defaultLocale: string; locales?: string[] };
  capabilities?: { required?: string[] };
  extensions?: Record<string, JsonValue>;
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                        */
/* ------------------------------------------------------------------ */

export type DiagnosticCode =
  | 'FORM_SCHEMA_INVALID' | 'FORM_VERSION_UNSUPPORTED' | 'FORM_ID_INVALID'
  | 'FIELD_TYPE_UNKNOWN' | 'FIELD_ID_DUPLICATE' | 'FIELD_KEY_DUPLICATE' | 'FIELD_KEY_INVALID'
  | 'FIELD_REFERENCE_INVALID' | 'EXPRESSION_PARSE_FAILED' | 'EXPRESSION_REFERENCE_INVALID'
  | 'DEPENDENCY_CYCLE_DETECTED' | 'DATA_SOURCE_UNRESOLVED' | 'DATA_SOURCE_DUPLICATE'
  | 'SUBMISSION_OPERATION_UNRESOLVED' | 'SUBMISSION_MAPPING_INVALID'
  | 'PLATFORM_CAPABILITY_UNSUPPORTED' | 'LAYOUT_REFERENCE_INVALID' | 'CONDITION_DUPLICATE'
  | 'FORMULA_DUPLICATE' | 'FORMULA_TARGET_INVALID' | 'VALIDATION_RULE_INVALID'
  | 'LIMIT_EXCEEDED' | 'EXTENSION_INVALID';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  /** JSON pointer into the source document. */
  path?: string;
  fieldId?: string;
  reference?: string;
  suggestion?: string;
}

/* ------------------------------------------------------------------ */
/* FormIR                                                             */
/* ------------------------------------------------------------------ */

export interface NormalizedField {
  id: string;
  type: string;
  key: string;               // concrete template path, e.g. items[].qty
  valueType: ValueType;
  label: LocalizedText;
  description?: LocalizedText;
  defaultValue: JsonValue | undefined;
  required: boolean; disabled: boolean; readonly: boolean; hidden: boolean;
  computed: boolean;
  validation: FieldValidation;
  options?: FieldOption[];
  optionSourceId?: string;
  optionValueKey: string; optionLabelKey: string;
  ui: NonNullable<FieldDef['ui']>;
  accessibility: NonNullable<FieldDef['accessibility']>;
  /** Parent repeater/group field id, if nested. */
  parentId?: string;
  /** Repeater row template owner (nearest repeater ancestor id). */
  repeaterId?: string;
  children: string[];        // child field ids
  sourcePointer: string;
}

export interface CompiledCondition { id: string; when: Expr; effects: ConditionEffect[]; reads: ParsedRef[] }
export interface CompiledFormula { id: string; target: string; expr: Expr; reads: ParsedRef[]; rowScoped: boolean }
export interface CompiledCrossRule { id: string; expr: Expr; message: LocalizedText; path?: string; severity: 'error' | 'warning'; reads: ParsedRef[] }

export interface DependencyEdge { from: string; to: string; kind: 'formula' | 'condition' | 'validation' | 'options' }

export interface FormIR {
  irVersion: typeof IR_VERSION;
  specVersion: string;
  compilerVersion: string;
  formId: string;
  formVersion: string;
  fields: NormalizedField[];
  layout: LayoutNode;
  conditions: CompiledCondition[];
  formulas: CompiledFormula[];
  crossFieldRules: CompiledCrossRule[];
  asyncRules: AsyncValidationRule[];
  dataSources: DataSourceDef[];
  submission?: SubmissionDef;
  persistence: PersistenceDef;
  security: SecurityDef;
  localization: { defaultLocale: string; locales: string[] };
  requiredCapabilities: string[];
  dependencies: { edges: DependencyEdge[]; order: string[] };
  sourceMap: Record<string, string>;
  fingerprint: string;
}

/* ------------------------------------------------------------------ */
/* Validation results                                                 */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  code: string;
  message: string;
  path: string;
  fieldId?: string;
  severity: 'error' | 'warning' | 'info';
  source: 'schema' | 'field' | 'async' | 'server' | 'cross';
}
export interface ValidationResult { valid: boolean; issues: ValidationIssue[] }

/* ------------------------------------------------------------------ */
/* Runtime state                                                      */
/* ------------------------------------------------------------------ */

export type FormState =
  | 'uninitialized' | 'compiling' | 'ready' | 'dirty' | 'validating' | 'invalid'
  | 'submitting' | 'submission-failed' | 'submission-succeeded'
  | 'offline-queued' | 'restoring-draft' | 'suspended' | 'disposed';

export interface DataSourceStatus {
  status: 'idle' | 'loading' | 'ready' | 'error';
  options?: FieldOption[];
  error?: { code: string; message: string };
}

export interface SubmissionStatus {
  status: 'idle' | 'submitting' | 'succeeded' | 'failed' | 'queued';
  attemptId?: string;
  result?: SubmissionResult;
}

export interface FormSnapshot {
  state: FormState;
  values: FormValues;
  dirty: boolean;
  dirtyPaths: string[];
  touched: Record<string, boolean>;
  focusedPath: string | null;
  issues: ValidationIssue[];
  visibility: Record<string, boolean>;
  disabled: Record<string, boolean>;
  readonly: Record<string, boolean>;
  required: Record<string, boolean>;
  repeaterRows: Record<string, string[]>;   // repeater field id -> stable row ids
  dataSources: Record<string, DataSourceStatus>;
  asyncValidation: Record<string, { status: 'idle' | 'pending' | 'validating' | 'error'; message?: string }>;
  submission: SubmissionStatus;
  draft: { status: 'none' | 'saving' | 'saved' | 'restored' | 'error' | 'conflict'; savedAt?: string; message?: string };
  diagnostics: Array<{ code: string; message: string; path?: string }>;
  metrics: { evaluations: number; validations: number; submissions: number };
}

/* ------------------------------------------------------------------ */
/* Submission execution contracts                                     */
/* ------------------------------------------------------------------ */

export interface SubmissionAction { operationRef: string; operationVersion?: string }

export interface AuthContext {
  userId?: string;
  tenantId?: string;
  roles: string[];
  permissions: string[];
  sessionId?: string;
}

export interface SubmissionContext {
  formId: string;
  formVersion: string;
  specVersion: string;
  /** Mapped, normalized payload (never contains credentials). */
  values: Record<string, unknown>;
  /** Trusted-server principal only. The headless runtime MUST NOT populate this
   * from UI auth; trusted executors receive identity from their own server-side
   * principal source (framework user, validated token, or executor config). */
  authenticatedContext?: AuthContext;
  idempotencyKey: string;
  correlationId: string;
  signal?: AbortSignal;
}

export type SubmissionResult =
  | { status: 'succeeded'; operationRef: string; data: unknown; executionId?: string; idempotencyKey: string; durationMs: number }
  | { status: 'queued-offline'; queueId: string; idempotencyKey: string }
  | { status: 'validation-failed'; issues: ValidationIssue[] }
  | { status: 'server-validation-failed'; issues: ValidationIssue[] }
  | { status: 'permission-denied'; code: string; message: string; requiredPermissions?: string[] }
  | { status: 'network-failure'; code: string; message: string; retryable: boolean }
  | { status: 'business-rejected'; code: string; message: string; details?: unknown }
  | { status: 'config-error'; code: SubmissionConfigErrorCode; message: string }
  | { status: 'cancelled'; idempotencyKey: string };

export type SubmissionConfigErrorCode =
  | 'SUBMISSION_EXECUTOR_NOT_REGISTERED'
  | 'SUBMISSION_OPERATION_UNRESOLVED'
  | 'SUBMISSION_MAPPING_INVALID'
  | 'SUBMISSION_NOT_CONFIGURED'
  | 'SUBMISSION_IN_PROGRESS'
  | 'FORM_NOT_INITIALIZED'
  | 'FORM_DISPOSED'
  | 'OFFLINE_QUEUE_NOT_PERMITTED'
  | 'PERMISSION_DENIED';

export interface ExecutorContract {
  /** Operation may be safely queued offline and replayed with its idempotency key. */
  supportsOfflineQueue: boolean;
  /** Operation is idempotent by contract (safe automatic retry). */
  idempotent: boolean;
  /** Executor runs in a trusted server environment. */
  trusted: boolean;
}

export interface SubmissionExecutor {
  /** URI scheme this executor owns, e.g. `api`, `database`, `logic`, `test`. */
  readonly scheme: string;
  readonly contract: ExecutorContract;
  supports(action: SubmissionAction): boolean | Promise<boolean>;
  execute(action: SubmissionAction, context: SubmissionContext): Promise<SubmissionResult>;
}

/* ------------------------------------------------------------------ */
/* Data source providers                                              */
/* ------------------------------------------------------------------ */

export interface DataSourceRequest {
  providerRef: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  cursor?: string;
  search?: string;
}
export interface DataSourceResponse { items: unknown[]; nextCursor?: string; total?: number }
export interface DataSourceProvider {
  readonly scheme: string;
  query(request: DataSourceRequest): Promise<DataSourceResponse>;
}

/* ------------------------------------------------------------------ */
/* Persistence contracts                                              */
/* ------------------------------------------------------------------ */

export interface DraftEnvelope {
  envelopeVersion: 1;
  formId: string;
  formVersion: string;
  specVersion: string;
  /** Isolation key: user/tenant/device scoped. */
  scopeKey: string;
  values: FormValues;
  savedAt: string;
  expiresAt?: string;
}
export interface DraftStorageAdapter {
  save(envelope: DraftEnvelope): Promise<void>;
  load(formId: string, scopeKey: string): Promise<DraftEnvelope | null>;
  clear(formId: string, scopeKey: string): Promise<void>;
}

export type QueuedSubmissionStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'conflict' | 'cancelled';
export interface QueuedSubmissionRecord {
  id: string;
  operationRef: string;
  operationVersion?: string;
  formId: string;
  formVersion: string;
  specVersion: string;
  scopeKey: string;
  values: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
  status: QueuedSubmissionStatus;
  attempts: number;
  maxAttempts: number;
  failure?: { code: string; message: string };
  conflict?: { reason: string; detectedAt: string };
}
export interface OfflineQueueAdapter {
  enqueue(record: QueuedSubmissionRecord): Promise<void>;
  list(scopeKey: string): Promise<QueuedSubmissionRecord[]>;
  update(id: string, patch: Partial<QueuedSubmissionRecord>): Promise<void>;
  remove(id: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Assets / uploads                                                   */
/* ------------------------------------------------------------------ */

export interface NormalizedAsset {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  source: 'picker' | 'camera' | 'drag-drop' | 'generated';
  /** Platform-local handle (never persisted into form definitions). */
  localUri?: string;
}
export interface UploadedAssetRef { assetRef: string; name: string; mimeType: string; sizeBytes: number; url?: string }
export interface UploadProvider {
  readonly scheme: string;
  upload(request: {
    asset: NormalizedAsset;
    constraints?: { accept?: string[]; maxSizeBytes?: number };
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
    auth?: AuthContext;
  }): Promise<UploadedAssetRef>;
}

/* ------------------------------------------------------------------ */
/* RBAC / workflow integration contracts                              */
/* ------------------------------------------------------------------ */

export interface RbacEvaluator {
  evaluate(auth: AuthContext | undefined, required: string[]): { allowed: boolean; missing: string[] };
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                       */
/* ------------------------------------------------------------------ */

export interface FieldCapability {
  fieldType: string;
  contractVersion: string;
  valueType: ValueType;
  supportsValidation: boolean;
  supportsAsyncValidation: boolean;
  supportsAccessibility: boolean;
  supportsLocalization: boolean;
  supportsReadonly: boolean;
  supportsDisabled: boolean;
  supportsDynamicOptions: boolean;
  requiresNativeModule: boolean;
  fallbackStrategy?: string;
}
/**
 * Explicit capability status. A capability may only be `supported` when it is
 * implemented, wired into the renderer, covered by tests AND usable.
 *  - supported             : works out of the box on this target
 *  - partial               : works with documented limitations (`reason`)
 *  - unsupported           : not implemented on this target
 *  - requires-host-adapter : renderer code exists but needs an injected host
 *                            adapter (`requires`) before it can be used
 */
export type CapabilityStatus = 'supported' | 'partial' | 'unsupported' | 'requires-host-adapter';

export interface CapabilityDetail {
  status: CapabilityStatus;
  /** Host adapters that must be injected for a requires-host-adapter capability. */
  requires?: string[];
  /** Why a capability is partial/unsupported. */
  reason?: string;
}

export interface RendererCapabilityManifest {
  target: string;
  contractVersion: string;
  fieldTypes: Record<string, FieldCapability>;
  /**
   * Boolean shorthand: true ONLY when the explicit status is `supported`.
   * Kept for the compiler's capability negotiation; `featureStatus` is the
   * authoritative, non-lossy description.
   */
  features: {
    dragDrop?: boolean; camera?: boolean; filePicker?: boolean;
    offlineQueue?: boolean; draftPersistence?: boolean; multiStep?: boolean;
    repeaters?: boolean; richText?: boolean; signature?: boolean;
  };
  /** Authoritative per-feature status (see CapabilityStatus). */
  featureStatus?: Record<string, CapabilityDetail>;
  /** Explicit per-field status, overriding the registry default for this target. */
  fieldStatus?: Record<string, CapabilityDetail>;
  /** Per-layout-node status for all 14 canonical layout node types. */
  layoutStatus?: Record<string, CapabilityDetail>;
  /** Test/CI evidence backing the claims (never inferred from compilation). */
  evidence?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Plugins                                                            */
/* ------------------------------------------------------------------ */

export type PluginRegistrationKind =
  | 'field' | 'validator' | 'formulaFunction' | 'expressionFunction'
  | 'dataSourceProvider' | 'persistenceAdapter' | 'uploadProvider'
  | 'submissionExecutor' | 'rendererComponent' | 'inspectorPanel'
  | 'diagnosticsProvider' | 'migrationHandler';

export interface PluginManifest {
  id: string;
  version: string;
  contractVersion: string;
  targets: string[];
  provides: Array<{ kind: PluginRegistrationKind; name: string }>;
  dependencies?: Array<{ id: string; versionRange: string }>;
  permissions?: string[];
  /** 'sandboxed'/'untrusted' are rejected until a real isolation adapter exists.
   * Omitted trust is treated as host-registered trusted code (legacy). */
  trust?: 'trusted' | 'sandboxed' | 'untrusted';
}

/**
 * The 14 canonical layout node types (vds.form 1.0.0). Mirrors
 * specifications/json-schema/vds-form-1.0.0.schema.json `$defs/layoutNode`.
 * Renderers must implement every one of them or report it explicitly.
 */
export const CANONICAL_LAYOUT_NODES = [
  'section', 'group', 'row', 'columns', 'tabs', 'tab', 'accordion', 'steps',
  'step', 'fieldset', 'summary', 'repeater', 'divider', 'text',
] as const;

/** Convenience constructors for explicit capability statuses. */
export const capSupported = (): CapabilityDetail => ({ status: 'supported' });
export const capUnsupported = (reason: string): CapabilityDetail => ({ status: 'unsupported', reason });
export const capPartial = (reason: string): CapabilityDetail => ({ status: 'partial', reason });
export const capHostAdapter = (requires: string[], reason: string): CapabilityDetail => ({
  status: 'requires-host-adapter', requires, reason,
});

/** Derives the boolean shorthand from explicit statuses (true only if supported). */
export function featuresFromStatus(status: Record<string, CapabilityDetail>): RendererCapabilityManifest['features'] {
  const keys = ['dragDrop', 'camera', 'filePicker', 'offlineQueue', 'draftPersistence', 'multiStep', 'repeaters', 'richText', 'signature'] as const;
  const out: Record<string, boolean> = {};
  for (const k of keys) if (status[k]) out[k] = status[k].status === 'supported';
  return out;
}

/** All-14 layout nodes marked supported (targets that implement the full set). */
export function allLayoutsSupported(): Record<string, CapabilityDetail> {
  return Object.fromEntries(CANONICAL_LAYOUT_NODES.map((n) => [n, capSupported()]));
}
