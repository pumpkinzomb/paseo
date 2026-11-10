/** A late RPC completion must never steal navigation after the user leaves. */
export function createAssistantEntry<T>(ports: {
  open: () => Promise<T>;
  navigate: (result: T) => void;
}) {
  let generation = 0;
  let pending: Promise<T> | null = null;
  return {
    async open() {
      const current = ++generation;
      const operation = pending ?? ports.open();
      pending = operation;
      try {
        const result = await operation;
        if (current === generation) ports.navigate(result);
        return result;
      } finally {
        if (pending === operation) pending = null;
      }
    },
    cancel() {
      generation += 1;
    },
  };
}
