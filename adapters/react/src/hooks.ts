import { useCallback, useSyncExternalStore } from 'react';
import type { FormController } from '@vds-form/runtime';
import type { FormSnapshot } from '@vds-form/types';

export function useFormSnapshot(controller: FormController): FormSnapshot {
  const subscribe = useCallback((cb: () => void) => controller.subscribe(cb), [controller]);
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

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

const sliceCaches = new WeakMap<FormController, Map<string, { key: string; slice: FieldSlice }>>();

export function useField(controller: FormController, path: string): FieldSlice {
  const subscribe = useCallback((cb: () => void) => controller.subscribeField(path, () => cb()), [controller, path]);
  const cached = useCallback(() => {
    const slice = controller.fieldSlice(path) as FieldSlice;
    const key = JSON.stringify(slice);
    let store = sliceCaches.get(controller);
    if (!store) { store = new Map(); sliceCaches.set(controller, store); }
    if (store.get(path)?.key !== key) store.set(path, { key, slice });
    return store.get(path)!.slice;
  }, [controller, path]);
  return useSyncExternalStore(subscribe, cached, cached);
}
