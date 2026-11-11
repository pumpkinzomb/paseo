import { useLayoutEffect, useRef } from "react";
const blockers = new Map<object, string>();
const listeners = new Set<() => void>();
export function getUpdateTransientBlockers(): string[] {
  return [...new Set(blockers.values())];
}
export function subscribeUpdateTransientState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useUpdateTransientBlocker(reason: string, active: boolean): void {
  const token = useRef({});
  useLayoutEffect(() => {
    const key = token.current;
    if (!active) return;
    blockers.set(key, reason);
    for (const listener of listeners) listener();
    return () => {
      blockers.delete(key);
      for (const listener of listeners) listener();
    };
  }, [active, reason]);
}
