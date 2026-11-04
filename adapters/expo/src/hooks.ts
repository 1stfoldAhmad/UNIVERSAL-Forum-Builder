import { useCallback, useSyncExternalStore } from 'react';
import type { FormController } from '@vds-form/runtime';
import type { FormSnapshot } from '@vds-form/types';

/** Whole-form subscription (React 18+ concurrent-safe). */
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

/** Selective field subscription — re-renders only when this path's slice changes. */
export function useField(controller: FormController, path: string): FieldSlice {
  const subscribe = useCallback(
    (cb: () => void) => controller.subscribeField(path, () => cb()),
    [controller, path],
  );
  const getSnapshot = useCallback(() => controller.fieldSlice(path) as FieldSlice, [controller, path]);
  // fieldSlice returns a fresh object each call; cache by JSON identity for useSyncExternalStore.
  const cached = useCallback(() => {
    const slice = getSnapshot();
    const key = JSON.stringify(slice);
    const store = cacheFor(controller);
    if (store.get(path)?.key !== key) store.set(path, { key, slice });
    return store.get(path)!.slice;
  }, [controller, path, getSnapshot]);
  return useSyncExternalStore(subscribe, cached, cached);
}

const sliceCaches = new WeakMap<FormController, Map<string, { key: string; slice: FieldSlice }>>();
function cacheFor(controller: FormController) {
  let m = sliceCaches.get(controller);
  if (!m) { m = new Map(); sliceCaches.set(controller, m); }
  return m;
}
