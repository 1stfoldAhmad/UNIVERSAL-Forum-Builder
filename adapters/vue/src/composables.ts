import { onScopeDispose, shallowRef, toRaw, type ShallowRef } from 'vue';
import type { FormController } from '@vds-form/runtime';
import type { FormSnapshot } from '@vds-form/types';

export interface FieldSlice {
  value: unknown;
  touched: boolean;
  focused: boolean;
  issues: Array<{ code: string; message: string; path: string; severity: string }>;
  visible: boolean;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
}

/** Reactive form snapshot; cleaned up automatically with the component scope. */
export function useFormSnapshot(input: FormController): ShallowRef<FormSnapshot> {
  const controller = toRaw(input);
  const snap = shallowRef(controller.getSnapshot());
  const unsubscribe = controller.subscribe((s) => { snap.value = s; });
  onScopeDispose(unsubscribe);
  return snap;
}

/** Reactive single-field slice; only re-renders when that slice changes. */
export function useFormField(input: FormController, path: string): ShallowRef<FieldSlice> {
  const controller = toRaw(input);
  const slice = shallowRef(controller.fieldSlice(path) as FieldSlice);
  const unsubscribe = controller.subscribeField(path, (s) => { slice.value = s as FieldSlice; });
  onScopeDispose(unsubscribe);
  return slice;
}
