import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import type { FormController } from '@vds-form/runtime';
import type { LayoutNode, NormalizedField, SubmissionResult } from '@vds-form/types';
import { localize } from '@vds-form/validation';
import { useFormSnapshot } from './hooks';
import { FieldRenderer, fieldStyles } from './fields';
import type { ExpoPickerAdapters } from './capabilities';

export interface ExpoFormProps {
  controller: FormController;
  pickers?: ExpoPickerAdapters;
  locale?: string;
  onSubmitted?: (result: SubmissionResult) => void;
  submitLabel?: string;
}

export function ExpoForm({ controller, pickers, locale, onSubmitted, submitLabel }: ExpoFormProps) {
  const snap = useFormSnapshot(controller);
  const loc = locale ?? controller.ir.localization.defaultLocale;
  const focusRegistry = useRef(new Map<string, () => void>());
  const registerFocus = useCallback((path: string, focus: () => void) => {
    focusRegistry.current.set(path, focus);
  }, []);
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  const fieldById = useMemo(() => new Map(controller.ir.fields.map((f) => [f.id, f])), [controller]);
  const topLevel = useMemo(() => controller.ir.fields.filter((f) => !f.parentId), [controller]);

  const renderField = (field: NormalizedField, path: string): React.ReactNode => {
    if (field.type === 'group') {
      const children = controller.ir.fields.filter((f) => f.parentId === field.id);
      return (
        <View key={field.id} style={{ marginBottom: 12, padding: 12, borderWidth: 1, borderColor: '#e2e2e2', borderRadius: 10 }} accessibilityRole="none" testID={`group-${field.id}`}>
          <Text style={{ fontWeight: '700', fontSize: 16, marginBottom: 8 }}>{localize(field.label, loc)}</Text>
          {children.map((c) => renderField(c, c.key))}
        </View>
      );
    }
    if (field.type === 'repeater') {
      return <RepeaterView key={field.id} controller={controller} field={field} locale={loc} pickers={pickers} registerFocus={registerFocus} renderField={renderField} />;
    }
    return <FieldRenderer key={`${field.id}-${path}`} controller={controller} field={field} path={path} locale={loc} pickers={pickers} registerFocus={registerFocus} />;
  };

  const renderLayout = (node: LayoutNode, key: string): React.ReactNode => {
    const title = node.title ? localize(node.title, loc) : undefined;
    const fieldNodes = (node.fieldRefs ?? []).map((id) => {
      const f = fieldById.get(id);
      return f ? renderField(f, f.key) : null;
    });
    switch (node.type) {
      case 'steps': {
        const steps = (node.children ?? []).filter((c) => c.type === 'step' || c.type === 'summary');
        const current = steps[Math.min(stepIndex, steps.length - 1)];
        const isLast = stepIndex >= steps.length - 1;
        const stepFieldIds = collectFieldRefs(current);
        const stepHasErrors = snap.issues.some((i) => {
          const f = controller.ir.fields.find((x) => i.path === x.key || i.path.startsWith(`${x.key}.`));
          return f && stepFieldIds.includes(f.id) && i.severity === 'error';
        });
        return (
          <View key={key} testID="wizard">
            <View style={{ flexDirection: 'row', marginBottom: 12 }}>
              {steps.map((s, i) => (
                <View key={s.id ?? i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= stepIndex ? '#1f6feb' : '#ddd', marginRight: 4 }} />
              ))}
            </View>
            <Text style={{ fontSize: 18, fontWeight: '700', marginBottom: 12 }} accessibilityRole="header">
              {title ? `${title} — ` : ''}{current?.title ? localize(current.title, loc) : `Step ${stepIndex + 1}`}
            </Text>
            {current?.type === 'summary' ? (
              <SummaryView controller={controller} locale={loc} />
            ) : renderLayout(current ?? { type: 'group' }, `${key}-current`)}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <Pressable
                onPress={() => setStepIndex((i) => Math.max(0, i - 1))}
                disabled={stepIndex === 0}
                style={[fieldStyles.button, fieldStyles.secondaryButton, stepIndex === 0 ? { opacity: 0.4 } : null]}
                accessibilityRole="button" accessibilityLabel="Previous step" testID="wizard-back"
              >
                <Text style={[fieldStyles.buttonText, fieldStyles.secondaryText]}>Back</Text>
              </Pressable>
              {!isLast ? (
                <Pressable
                  onPress={async () => {
                    if (advancing) return; // guard against double-advance races
                    setAdvancing(true);
                    try {
                      for (const id of stepFieldIds) {
                        const f = fieldById.get(id);
                        if (f) controller.blur(f.key);
                      }
                      const result = await controller.validate();
                      const errs = result.issues.some((i) => {
                        const f = controller.ir.fields.find((x) => i.path === x.key || i.path.startsWith(`${x.key}.`));
                        return f && stepFieldIds.includes(f.id) && i.severity === 'error';
                      });
                      if (!errs) setStepIndex((i) => i + 1);
                    } finally {
                      setAdvancing(false);
                    }
                  }}
                  disabled={advancing}
                  style={[fieldStyles.button, advancing ? { opacity: 0.6 } : null]}
                  accessibilityRole="button" accessibilityLabel="Next step" accessibilityState={{ busy: advancing }} testID="wizard-next"
                >
                  <Text style={fieldStyles.buttonText}>Next</Text>
                </Pressable>
              ) : null}
            </View>
            {stepHasErrors && snap.state === 'invalid' ? (
              <Text style={fieldStyles.error} accessibilityRole="alert">Please fix the errors above to continue.</Text>
            ) : null}
          </View>
        );
      }
      case 'section': case 'group': case 'fieldset': case 'row': case 'columns': case 'tab': case 'accordion':
        return (
          <View key={key} style={{ marginBottom: 16 }} testID={node.id ? `layout-${node.id}` : undefined}>
            {title ? <Text style={{ fontSize: 18, fontWeight: '700', marginBottom: 10 }} accessibilityRole="header">{title}</Text> : null}
            {fieldNodes}
            {(node.children ?? []).map((c, i) => renderLayout(c, `${key}-${i}`))}
          </View>
        );
      case 'tabs':
        return <View key={key}>{(node.children ?? []).map((c, i) => renderLayout(c, `${key}-${i}`))}</View>;
      case 'divider':
        return <View key={key} style={{ height: 1, backgroundColor: '#e0e0e0', marginVertical: 12 }} />;
      case 'text':
        return <Text key={key} style={{ color: '#444', marginBottom: 12 }}>{node.text ? localize(node.text, loc) : ''}</Text>;
      case 'summary':
        return <SummaryView key={key} controller={controller} locale={loc} />;
      case 'repeater': {
        const f = node.repeaterRef ? fieldById.get(node.repeaterRef) : undefined;
        return f ? renderField(f, f.key) : null;
      }
      default:
        return <View key={key}>{fieldNodes}</View>;
    }
  };

  const doSubmit = async () => {
    setSubmitting(true);
    try {
      const result = await controller.submit();
      onSubmitted?.(result);
    } finally {
      setSubmitting(false);
    }
  };

  const errorIssues = snap.issues.filter((i) => i.severity === 'error');
  const showSummary = (snap.state === 'invalid' || snap.submission.status === 'failed') && errorIssues.length > 0;
  const submitResult = snap.submission.result;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }} testID="expo-form-scroll">
        <Text style={{ fontSize: 22, fontWeight: '800', marginBottom: 16 }} accessibilityRole="header">
          {localize(controller.ir.fields.length ? (controller.ir as unknown as { formId: string }).formId && formTitle(controller) : '', loc)}
        </Text>
        {renderLayout(controller.ir.layout, 'root')}
        {showSummary ? (
          <View style={{ backgroundColor: '#fdecea', borderRadius: 8, padding: 12, marginBottom: 12 }} accessibilityRole="alert" testID="error-summary">
            <Text style={{ fontWeight: '700', color: '#c0392b', marginBottom: 6 }}>
              {errorIssues.length} problem{errorIssues.length === 1 ? '' : 's'} to fix:
            </Text>
            {errorIssues.slice(0, 8).map((i, idx) => (
              <Pressable key={idx} onPress={() => focusRegistry.current.get(i.path)?.()}>
                <Text style={{ color: '#c0392b', paddingVertical: 2 }}>• {i.message} ({i.path})</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {submitResult?.status === 'succeeded' ? (
          <View style={{ backgroundColor: '#e8f5e9', borderRadius: 8, padding: 12, marginBottom: 12 }} accessibilityRole="alert" testID="submit-success">
            <Text style={{ color: '#1b5e20', fontWeight: '600' }}>Submitted successfully.</Text>
          </View>
        ) : null}
        {submitResult?.status === 'queued-offline' ? (
          <View style={{ backgroundColor: '#fff8e1', borderRadius: 8, padding: 12, marginBottom: 12 }} accessibilityRole="alert" testID="submit-queued">
            <Text style={{ color: '#8d6e00' }}>Saved offline — will submit when you are back online. Not yet submitted to the server.</Text>
          </View>
        ) : null}
        {submitResult && submitResult.status !== 'succeeded' && submitResult.status !== 'queued-offline' && submitResult.status !== 'validation-failed' ? (
          <View style={{ backgroundColor: '#fdecea', borderRadius: 8, padding: 12, marginBottom: 12 }} accessibilityRole="alert" testID="submit-error">
            <Text style={{ color: '#c0392b' }}>
              Submission failed: {'message' in submitResult ? submitResult.message : submitResult.status}
              {'code' in submitResult ? ` (${submitResult.code})` : ''}
            </Text>
          </View>
        ) : null}
        <Pressable
          onPress={doSubmit}
          disabled={submitting || snap.state === 'submitting'}
          style={[fieldStyles.button, (submitting || snap.state === 'submitting') ? { opacity: 0.6 } : null]}
          accessibilityRole="button"
          accessibilityLabel={submitLabel ?? 'Submit form'}
          accessibilityState={{ disabled: submitting || snap.state === 'submitting', busy: submitting }}
          testID="submit-button"
        >
          <Text style={fieldStyles.buttonText}>{submitting || snap.state === 'submitting' ? 'Submitting…' : submitLabel ?? 'Submit'}</Text>
        </Pressable>
        {topLevel.length === 0 ? <Text>No fields.</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function formTitle(controller: FormController): string {
  // IR does not carry metadata.name; renderers use the form id as accessible title fallback.
  return controller.ir.formId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function collectFieldRefs(node: LayoutNode | undefined): string[] {
  if (!node) return [];
  return [...(node.fieldRefs ?? []), ...(node.children ?? []).flatMap(collectFieldRefs)];
}

function RepeaterView(props: {
  controller: FormController; field: NormalizedField; locale: string;
  pickers?: ExpoPickerAdapters; registerFocus: (path: string, focus: () => void) => void;
  renderField: (field: NormalizedField, path: string) => React.ReactNode;
}) {
  const { controller, field, locale } = props;
  const snap = useFormSnapshot(controller);
  const rowIds = snap.repeaterRows[field.id] ?? [];
  const children = controller.ir.fields.filter((f) => f.parentId === field.id);
  const min = field.validation.minItems ?? 0;
  return (
    <View style={{ marginBottom: 16 }} testID={`repeater-${field.id}`}>
      <Text style={{ fontSize: 16, fontWeight: '700', marginBottom: 8 }} accessibilityRole="header">{localize(field.label, locale)}</Text>
      {rowIds.map((rowId, index) => (
        <View key={rowId} style={{ borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 10, padding: 12, marginBottom: 10 }} testID={`row-${field.id}-${rowId}`}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: '#666' }}>Entry {index + 1}</Text>
            <View style={{ flexDirection: 'row' }}>
              <Pressable onPress={() => controller.moveRepeaterItem(field.id, index, index - 1)} disabled={index === 0} accessibilityRole="button" accessibilityLabel={`Move entry ${index + 1} up`} testID={`move-up-${rowId}`} style={{ paddingHorizontal: 8, opacity: index === 0 ? 0.3 : 1 }}>
                <Text>↑</Text>
              </Pressable>
              <Pressable onPress={() => controller.moveRepeaterItem(field.id, index, index + 1)} disabled={index === rowIds.length - 1} accessibilityRole="button" accessibilityLabel={`Move entry ${index + 1} down`} testID={`move-down-${rowId}`} style={{ paddingHorizontal: 8, opacity: index === rowIds.length - 1 ? 0.3 : 1 }}>
                <Text>↓</Text>
              </Pressable>
              <Pressable onPress={() => controller.removeRepeaterItem(field.id, rowId)} disabled={rowIds.length <= min} accessibilityRole="button" accessibilityLabel={`Remove entry ${index + 1}`} testID={`remove-${rowId}`} style={{ paddingHorizontal: 8, opacity: rowIds.length <= min ? 0.3 : 1 }}>
                <Text style={{ color: '#c0392b' }}>✕</Text>
              </Pressable>
            </View>
          </View>
          {children.map((c) => props.renderField(c, c.key.replace(`${field.key}[]`, `${field.key}.${index}`)))}
        </View>
      ))}
      <Pressable
        onPress={() => controller.addRepeaterItem(field.id)}
        style={[fieldStyles.button, fieldStyles.secondaryButton, { alignSelf: 'flex-start' }]}
        accessibilityRole="button" accessibilityLabel={`Add ${localize(field.label, locale)} entry`}
        testID={`add-${field.id}`}
      >
        <Text style={[fieldStyles.buttonText, fieldStyles.secondaryText]}>+ Add entry</Text>
      </Pressable>
    </View>
  );
}

function SummaryView({ controller, locale }: { controller: FormController; locale: string }) {
  const snap = useFormSnapshot(controller);
  const rows = controller.ir.fields.filter((f) => !f.parentId && f.type !== 'group' && f.type !== 'repeater' && snap.visibility[f.id] !== false);
  return (
    <View style={{ marginBottom: 12 }} testID="summary">
      {rows.map((f) => {
        const v = snap.values[f.key];
        return (
          <View key={f.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#eee' }}>
            <Text style={{ color: '#555' }}>{localize(f.label, locale)}</Text>
            <Text style={{ fontWeight: '600' }}>{v === null || v === undefined ? '—' : String(v)}</Text>
          </View>
        );
      })}
    </View>
  );
}
