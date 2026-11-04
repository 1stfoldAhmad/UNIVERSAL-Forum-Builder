/**
 * @vds-form/fields — semantic field contracts + capability registry.
 * A field is defined by its data semantics, not by any platform widget.
 * Only genuinely implemented contracts are registered (no alias inflation).
 */
import type { FieldCapability, FieldValidation, JsonValue, ValueType } from '@vds-form/types';

export interface FieldContract {
  type: string;
  valueType: ValueType;
  /** Value used when the field is empty/unset. */
  emptyValue: JsonValue;
  defaultValue?: JsonValue;
  /** Sensitive values are redacted by the inspector and never logged. */
  sensitive?: boolean;
  /** Value kinds accepted from renderers before normalization. */
  accepts: Array<'string' | 'number' | 'boolean' | 'array' | 'object' | 'asset' | 'null'>;
  builtInValidation?: FieldValidation;
  /** Required semantics: 'non-empty' (default) or 'must-be-true' (consent). */
  requiredMode?: 'non-empty' | 'must-be-true';
  capability: FieldCapability;
  /** Normalize a raw renderer value into the canonical value domain. */
  normalize?: (raw: unknown) => unknown;
}

const cap = (fieldType: string, valueType: ValueType, extra: Partial<FieldCapability> = {}): FieldCapability => ({
  fieldType,
  contractVersion: '1.0.0',
  valueType,
  supportsValidation: true,
  supportsAsyncValidation: true,
  supportsAccessibility: true,
  supportsLocalization: true,
  supportsReadonly: true,
  supportsDisabled: true,
  supportsDynamicOptions: false,
  requiresNativeModule: false,
  ...extra,
});

const strNorm = (raw: unknown): unknown => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return raw;
};
const numNorm = (raw: unknown): unknown => {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw; // leave invalid for validation to report
};
const intNorm = (raw: unknown): unknown => {
  const n = numNorm(raw);
  return typeof n === 'number' && Number.isInteger(n) ? n : n;
};

function def(type: string, valueType: ValueType, emptyValue: JsonValue, extra: Partial<FieldContract> = {}): FieldContract {
  return {
    type, valueType, emptyValue,
    accepts: ['null'],
    capability: cap(type, valueType),
    ...extra,
  };
}

export const BUILTIN_FIELD_CONTRACTS: FieldContract[] = [
  def('text', 'string', null, { accepts: ['string', 'null'], normalize: strNorm }),
  def('textarea', 'string', null, { accepts: ['string', 'null'], normalize: strNorm }),
  def('email', 'string', null, { accepts: ['string', 'null'], normalize: strNorm, builtInValidation: { format: 'email' } }),
  def('password', 'string', null, { accepts: ['string', 'null'], normalize: strNorm, sensitive: true }),
  def('url', 'string', null, { accepts: ['string', 'null'], normalize: strNorm, builtInValidation: { format: 'url' } }),
  def('phone', 'string', null, { accepts: ['string', 'null'], normalize: strNorm, builtInValidation: { format: 'phone' } }),
  def('integer', 'integer', null, { accepts: ['number', 'string', 'null'], normalize: intNorm }),
  def('decimal', 'number', null, { accepts: ['number', 'string', 'null'], normalize: numNorm }),
  def('currency', 'number', null, { accepts: ['number', 'string', 'null'], normalize: numNorm, builtInValidation: { precision: 2 } }),
  def('percentage', 'number', null, { accepts: ['number', 'string', 'null'], normalize: numNorm, builtInValidation: { min: 0, max: 100 } }),
  def('range', 'number', null, { accepts: ['number', 'null'], normalize: numNorm, builtInValidation: { min: 0, max: 100 } }),
  def('select', 'string', null, { accepts: ['string', 'number', 'boolean', 'null'], capability: cap('select', 'string', { supportsDynamicOptions: true }) }),
  def('multiselect', 'string[]', [], { accepts: ['array', 'null'], capability: cap('multiselect', 'string[]', { supportsDynamicOptions: true }) }),
  def('radio', 'string', null, { accepts: ['string', 'number', 'boolean', 'null'] }),
  def('checkbox', 'boolean', false, { accepts: ['boolean', 'null'], defaultValue: false }),
  def('switch', 'boolean', false, { accepts: ['boolean', 'null'], defaultValue: false }),
  def('consent', 'boolean', false, { accepts: ['boolean', 'null'], defaultValue: false, requiredMode: 'must-be-true' }),
  def('date', 'string', null, { accepts: ['string', 'null'], builtInValidation: { format: 'date' } }),
  def('time', 'string', null, { accepts: ['string', 'null'], builtInValidation: { format: 'time' } }),
  def('datetime', 'string', null, { accepts: ['string', 'null'], builtInValidation: { format: 'date-time' } }),
  def('duration', 'number', null, { accepts: ['number', 'null'], normalize: numNorm }),
  def('rating', 'integer', null, { accepts: ['number', 'null'], normalize: intNorm, builtInValidation: { min: 1, max: 5 } }),
  def('color', 'string', null, { accepts: ['string', 'null'], builtInValidation: { format: 'color' } }),
  def('barcode', 'string', null, { accepts: ['string', 'null'], builtInValidation: { format: 'barcode' } }),
  def('file', 'asset', null, {
    accepts: ['asset', 'object', 'array', 'null'],
    capability: cap('file', 'asset', { requiresNativeModule: true, fallbackStrategy: 'file-picker' }),
  }),
  def('image', 'asset', null, {
    accepts: ['asset', 'object', 'null'],
    builtInValidation: { accept: ['image/png', 'image/jpeg', 'image/webp'] },
    capability: cap('image', 'asset', { requiresNativeModule: true, fallbackStrategy: 'image-picker' }),
  }),
  def('signature', 'asset', null, {
    accepts: ['asset', 'object', 'null'],
    capability: cap('signature', 'asset', { requiresNativeModule: true, fallbackStrategy: 'signature-pad' }),
  }),
  def('computed', 'number', null, { accepts: ['number', 'string', 'boolean', 'object', 'array', 'null'] }),
  def('hidden', 'string', null, { accepts: ['string', 'number', 'boolean', 'object', 'array', 'null'] }),
  def('group', 'object', {}, { accepts: ['object', 'null'], capability: cap('group', 'object', { supportsValidation: false }) }),
  def('repeater', 'object[]', [], {
    accepts: ['array', 'null'],
    capability: cap('repeater', 'object[]', { supportsValidation: true }),
  }),
];

export class FieldRegistry {
  private contracts = new Map<string, FieldContract>();

  constructor(contracts: FieldContract[] = []) {
    for (const c of contracts) this.register(c);
  }
  register(contract: FieldContract): void {
    if (this.contracts.has(contract.type)) {
      throw new Error(`FIELD_TYPE_DUPLICATE: "${contract.type}" is already registered.`);
    }
    this.contracts.set(contract.type, contract);
  }
  unregister(type: string): boolean { return this.contracts.delete(type); }
  get(type: string): FieldContract | undefined { return this.contracts.get(type); }
  has(type: string): boolean { return this.contracts.has(type); }
  list(): FieldContract[] { return [...this.contracts.values()].sort((a, b) => a.type.localeCompare(b.type)); }
  get size(): number { return this.contracts.size; }
}

export function createDefaultFieldRegistry(): FieldRegistry {
  return new FieldRegistry(BUILTIN_FIELD_CONTRACTS);
}
export const defaultFieldRegistry = createDefaultFieldRegistry();

/** Capability requirements implied by field types / layout (semantic, platform-neutral). */
export function capabilitiesForField(type: string, widget?: string): string[] {
  switch (type) {
    case 'file': return ['file-upload'];
    case 'image': return widget === 'camera' ? ['file-upload', 'camera'] : ['file-upload'];
    case 'signature': return ['signature'];
    case 'repeater': return ['repeaters'];
    default: return [];
  }
}
