import type { MutableRefObject, Ref, RefCallback } from 'react';

/** Combines several refs (callback or object) into one callback ref. Internal to the form primitives. */
export function mergeRefs<T>(...refs: ReadonlyArray<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as MutableRefObject<T | null>).current = node;
    }
  };
}

/** True for any ReactNode that would render something visible (0 counts, empty strings and booleans do not). */
export function hasContent(node: unknown): boolean {
  return node !== undefined && node !== null && node !== false && node !== true && node !== '';
}
