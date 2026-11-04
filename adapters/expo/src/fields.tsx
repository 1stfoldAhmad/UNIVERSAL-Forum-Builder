import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, Switch, Modal, FlatList, ScrollView,
  type KeyboardTypeOptions,
} from 'react-native';
import type { FormController } from '@vds-form/runtime';
import type { FieldOption, NormalizedField, UploadedAssetRef } from '@vds-form/types';
import { localize } from '@vds-form/validation';
import { useField } from './hooks';
import type { ExpoPickerAdapters } from './capabilities';

export interface FieldProps {
  controller: FormController;
  field: NormalizedField;
  /** Concrete key path (repeater rows substituted). */
  path: string;
  locale: string;
  pickers?: ExpoPickerAdapters;
  registerFocus?: (path: string, focus: () => void) => void;
}

const styles = {
  wrap: { marginBottom: 14 } as const,
  label: { fontSize: 15, fontWeight: '600' as const, marginBottom: 4, color: '#1a1a1a' },
  required: { color: '#c0392b' },
  input: {
    borderWidth: 1, borderColor: '#c9c9c9', borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 16, backgroundColor: '#fff', color: '#111',
  } as const,
  inputError: { borderColor: '#c0392b' },
  help: { fontSize: 13, color: '#555', marginTop: 3 },
  error: { fontSize: 13, color: '#c0392b', marginTop: 3 },
  button: {
    backgroundColor: '#1f6feb', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16,
    alignItems: 'center' as const,
  },
  buttonText: { color: '#fff', fontWeight: '600' as const, fontSize: 16 },
  secondaryButton: { backgroundColor: '#e8e8e8' },
  secondaryText: { color: '#222' },
  optionRow: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#eee' },
  chip: { borderWidth: 1, borderColor: '#1f6feb', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12, marginRight: 8, marginBottom: 8 },
  chipSelected: { backgroundColor: '#1f6feb' },
};

export function FieldShell(props: FieldProps & { children: React.ReactNode; errorId?: string }) {
  const { controller, field, path, locale } = props;
  const slice = useField(controller, path);
  if (!slice.visible) return null;
  const label = localize(field.label, locale);
  const firstError = slice.issues.find((i) => i.severity === 'error');
  const showError = firstError && (slice.touched || controller.getSnapshot().submission.status !== 'idle');
  return (
    <View style={styles.wrap} accessibilityRole="none" nativeID={`field-${path}`}>
      <Text
        style={styles.label}
        accessibilityRole="text"
        nativeID={`label-${path}`}
      >
        {label}{slice.required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      {field.description ? <Text style={styles.help}>{localize(field.description, locale)}</Text> : null}
      {props.children}
      {field.ui.helpText ? <Text style={styles.help} nativeID={`help-${path}`}>{localize(field.ui.helpText, locale)}</Text> : null}
      {showError ? (
        <Text style={styles.error} accessibilityRole="alert" nativeID={`error-${path}`} testID={`error-${path}`}>
          {firstError.message}
        </Text>
      ) : null}
    </View>
  );
}

function keyboardTypeFor(type: string): KeyboardTypeOptions {
  switch (type) {
    case 'email': return 'email-address';
    case 'phone': return 'phone-pad';
    case 'integer': return 'number-pad';
    case 'decimal': case 'currency': case 'percentage': case 'range': case 'duration': return 'decimal-pad';
    case 'url': return 'url';
    default: return 'default';
  }
}

export function TextField(props: FieldProps) {
  const { controller, field, path } = props;
  const slice = useField(controller, path);
  const ref = React.useRef<TextInput>(null);
  React.useEffect(() => {
    props.registerFocus?.(path, () => ref.current?.focus());
  }, [path, props.registerFocus]);
  const multiline = field.type === 'textarea';
  return (
    <FieldShell {...props}>
      <TextInput
        ref={ref}
        style={[styles.input, slice.issues.length && slice.touched ? styles.inputError : null, multiline ? { minHeight: 24 * (field.ui.rows ?? 4), textAlignVertical: 'top' } : null]}
        value={slice.value === null || slice.value === undefined ? '' : String(slice.value)}
        onChangeText={(t) => controller.setFieldValue(path, t)}
        onFocus={() => controller.focus(path)}
        onBlur={() => controller.blur(path)}
        editable={!slice.disabled && !slice.readonly}
        secureTextEntry={field.type === 'password'}
        keyboardType={keyboardTypeFor(field.type)}
        autoCapitalize={field.type === 'email' || field.type === 'url' || field.type === 'password' ? 'none' : 'sentences'}
        autoCorrect={field.type === 'email' || field.type === 'url'}
        multiline={multiline}
        numberOfLines={multiline ? field.ui.rows ?? 4 : 1}
        placeholder={field.ui.placeholder ? localize(field.ui.placeholder, props.locale) : undefined}
        accessibilityLabel={localize(field.label, props.locale)}
        accessibilityHint={field.accessibility.hint ? localize(field.accessibility.hint, props.locale) : undefined}
        accessibilityState={{ disabled: slice.disabled, required: slice.required }}
        accessibilityLabelledBy={`label-${path}`}
        accessibilityDescribedBy={slice.issues.length ? `error-${path}` : `help-${path}`}
        testID={`input-${path}`}
      />
    </FieldShell>
  );
}

export function BooleanField(props: FieldProps) {
  const { controller, field, path, locale } = props;
  const slice = useField(controller, path);
  const value = slice.value === true;
  if (field.type === 'switch') {
    return (
      <FieldShell {...props}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ flex: 1, fontSize: 15 }}>{localize(field.label, locale)}</Text>
          <Switch
            value={value}
            onValueChange={(v) => controller.setFieldValue(path, v)}
            disabled={slice.disabled || slice.readonly}
            accessibilityLabel={localize(field.label, locale)}
            accessibilityState={{ checked: value, disabled: slice.disabled }}
            testID={`switch-${path}`}
          />
        </View>
      </FieldShell>
    );
  }
  return (
    <FieldShell {...props}>
      <Pressable
        onPress={() => !slice.disabled && !slice.readonly && controller.setFieldValue(path, !value)}
        accessibilityRole="checkbox"
        accessibilityLabel={localize(field.label, locale)}
        accessibilityState={{ checked: value, disabled: slice.disabled }}
        style={{ flexDirection: 'row', alignItems: 'center' }}
        testID={`checkbox-${path}`}
      >
        <View style={{ width: 24, height: 24, borderWidth: 2, borderColor: value ? '#1f6feb' : '#999', borderRadius: 5, backgroundColor: value ? '#1f6feb' : '#fff', marginRight: 10, alignItems: 'center', justifyContent: 'center' }}>
          {value ? <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text> : null}
        </View>
        <Text style={{ fontSize: 15, flex: 1 }}>{localize(field.label, locale)}</Text>
      </Pressable>
    </FieldShell>
  );
}

export function SelectField(props: FieldProps) {
  const { controller, field, path, locale } = props;
  const slice = useField(controller, path);
  const [open, setOpen] = useState(false);
  const options: FieldOption[] = controller.getOptions(field.id);
  const selected = options.find((o) => o.value === slice.value);
  const multiple = field.type === 'multiselect';
  const selectedValues = Array.isArray(slice.value) ? (slice.value as Array<string | number | boolean>) : [];
  const toggle = (v: string | number | boolean) => {
    if (multiple) {
      const next = selectedValues.includes(v) ? selectedValues.filter((x) => x !== v) : [...selectedValues, v];
      controller.setFieldValue(path, next);
    } else {
      controller.setFieldValue(path, v);
      setOpen(false);
    }
  };
  const summary = multiple
    ? options.filter((o) => selectedValues.includes(o.value)).map((o) => localize(o.label, locale)).join(', ')
    : selected ? localize(selected.label, locale) : '';
  return (
    <FieldShell {...props}>
      <Pressable
        onPress={() => !slice.disabled && !slice.readonly && setOpen(true)}
        style={[styles.input, { flexDirection: 'row', justifyContent: 'space-between' }]}
        accessibilityRole="button"
        accessibilityLabel={`${localize(field.label, locale)}${summary ? `: ${summary}` : ''}`}
        accessibilityState={{ disabled: slice.disabled, expanded: open }}
        testID={`select-${path}`}
      >
        <Text style={{ color: summary ? '#111' : '#888', fontSize: 16 }}>{summary || localize(field.ui.placeholder, locale) || 'Select…'}</Text>
        <Text>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 }} onPress={() => setOpen(false)}>
          <View style={{ backgroundColor: '#fff', borderRadius: 12, maxHeight: 420 }} accessibilityRole="menu">
            <Text style={{ fontWeight: '700', fontSize: 16, padding: 16 }}>{localize(field.label, locale)}</Text>
            <FlatList
              data={options}
              keyExtractor={(o) => String(o.value)}
              renderItem={({ item }) => {
                const isSelected = multiple ? selectedValues.includes(item.value) : item.value === slice.value;
                return (
                  <Pressable
                    onPress={() => toggle(item.value)}
                    style={[styles.optionRow, isSelected ? { backgroundColor: '#eaf2ff' } : null]}
                    accessibilityRole={multiple ? 'checkbox' : 'menuitem'}
                    accessibilityState={{ selected: isSelected, checked: multiple ? isSelected : undefined }}
                    testID={`option-${path}-${String(item.value)}`}
                  >
                    <Text style={{ fontSize: 16 }}>{localize(item.label, locale)}{isSelected ? '  ✓' : ''}</Text>
                  </Pressable>
                );
              }}
            />
          </View>
        </Pressable>
      </Modal>
    </FieldShell>
  );
}

export function RadioField(props: FieldProps) {
  const { controller, field, path, locale } = props;
  const slice = useField(controller, path);
  const options = controller.getOptions(field.id);
  return (
    <FieldShell {...props}>
      <View accessibilityRole="radiogroup">
        {options.map((o) => {
          const selected = slice.value === o.value;
          return (
            <Pressable
              key={String(o.value)}
              onPress={() => !slice.disabled && controller.setFieldValue(path, o.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected, disabled: slice.disabled }}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}
              testID={`radio-${path}-${String(o.value)}`}
            >
              <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: selected ? '#1f6feb' : '#999', marginRight: 10, alignItems: 'center', justifyContent: 'center' }}>
                {selected ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#1f6feb' }} /> : null}
              </View>
              <Text style={{ fontSize: 15 }}>{localize(o.label, locale)}</Text>
            </Pressable>
          );
        })}
      </View>
    </FieldShell>
  );
}

export function RatingField(props: FieldProps) {
  const { controller, field, path, locale } = props;
  const slice = useField(controller, path);
  const max = field.validation.max ?? 5;
  const value = typeof slice.value === 'number' ? slice.value : 0;
  return (
    <FieldShell {...props}>
      <View style={{ flexDirection: 'row' }} accessibilityRole="adjustable" accessibilityLabel={localize(field.label, locale)} accessibilityValue={{ min: 1, max, now: value }}>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <Pressable key={n} onPress={() => !slice.disabled && !slice.readonly && controller.setFieldValue(path, n)} accessibilityRole="button" accessibilityLabel={`${n} of ${max}`} testID={`rating-${path}-${n}`}>
            <Text style={{ fontSize: 28, color: n <= value ? '#f5a623' : '#ccc', marginRight: 4 }}>★</Text>
          </Pressable>
        ))}
      </View>
    </FieldShell>
  );
}

export function FileField(props: FieldProps) {
  const { controller, field, path, locale, pickers } = props;
  const slice = useField(controller, path);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isImage = field.type === 'image';
  const multiple = field.validation.multiple === true;
  const picker = isImage ? pickers?.pickImage : pickers?.pickDocument;
  const available = Boolean(picker) && Boolean(controller.uploadProvider);
  const current = slice.value as UploadedAssetRef | UploadedAssetRef[] | null;

  const doPick = async () => {
    if (!picker || !controller.uploadProvider) return;
    setUploadError(null);
    try {
      const picked = isImage
        ? await pickers!.pickImage!({ accept: field.validation.accept })
        : (await pickers!.pickDocument!({ accept: field.validation.accept, multiple }))?.[0] ?? null;
      if (!picked) return;
      setProgress(0);
      const ref = await controller.uploadProvider.upload({
        asset: picked,
        constraints: { accept: field.validation.accept, maxSizeBytes: field.validation.maxSizeBytes },
        onProgress: setProgress,
        auth: controller.auth,
      });
      controller.setFieldValue(path, multiple ? [...(Array.isArray(current) ? current : []), ref] : ref);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <FieldShell {...props}>
      {!available ? (
        <View style={{ padding: 12, backgroundColor: '#f6f6f6', borderRadius: 8 }} accessibilityRole="alert" testID={`unsupported-${path}`}>
          <Text style={{ color: '#666' }}>
            File selection is unavailable: no native picker/upload adapter is registered on this host.
          </Text>
        </View>
      ) : (
        <View>
          {current ? (
            <Text style={styles.help} testID={`asset-${path}`}>
              {Array.isArray(current) ? current.map((a) => a.name).join(', ') : current.name} ✓ uploaded
            </Text>
          ) : null}
          <Pressable
            onPress={doPick}
            disabled={slice.disabled || slice.readonly || progress !== null}
            style={[styles.button, styles.secondaryButton, { alignSelf: 'flex-start' }]}
            accessibilityRole="button"
            accessibilityLabel={`${isImage ? 'Choose image' : 'Choose file'} for ${localize(field.label, locale)}`}
            accessibilityState={{ disabled: slice.disabled || progress !== null }}
            testID={`pick-${path}`}
          >
            <Text style={[styles.buttonText, styles.secondaryText]}>
              {progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : isImage ? 'Choose image' : 'Choose file'}
            </Text>
          </Pressable>
          {uploadError ? <Text style={styles.error} accessibilityRole="alert" testID={`upload-error-${path}`}>{uploadError}</Text> : null}
        </View>
      )}
    </FieldShell>
  );
}

export function ComputedField(props: FieldProps) {
  const { controller, field, path, locale } = props;
  const slice = useField(controller, path);
  const v = slice.value;
  const text = v === null || v === undefined ? '—' : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return (
    <FieldShell {...props}>
      <View style={[styles.input, { backgroundColor: '#f4f6f8' }]} accessibilityRole="text" accessibilityLabel={`${localize(field.label, locale)}: ${text}`} testID={`computed-${path}`}>
        <Text style={{ fontSize: 16, fontWeight: '600' }}>{text}</Text>
      </View>
    </FieldShell>
  );
}

const TEXT_TYPES = new Set(['text', 'textarea', 'email', 'password', 'url', 'phone', 'integer', 'decimal', 'currency', 'percentage', 'range', 'date', 'time', 'datetime', 'duration', 'color', 'barcode', 'hidden']);

export function FieldRenderer(props: FieldProps) {
  const { field } = props;
  const slice = useField(props.controller, props.path);
  if (!slice.visible || field.type === 'hidden') return null;
  if (TEXT_TYPES.has(field.type)) return <TextField {...props} />;
  switch (field.type) {
    case 'checkbox': case 'switch': case 'consent': return <BooleanField {...props} />;
    case 'select': case 'multiselect': return <SelectField {...props} />;
    case 'radio': return <RadioField {...props} />;
    case 'rating': return <RatingField {...props} />;
    case 'file': case 'image': return <FileField {...props} />;
    case 'computed': return <ComputedField {...props} />;
    default:
      return (
        <View style={{ padding: 12, backgroundColor: '#fff3cd', borderRadius: 8 }} accessibilityRole="alert">
          <Text>Field type "{field.type}" is not supported by the Expo renderer.</Text>
        </View>
      );
  }
}

export { styles as fieldStyles };
