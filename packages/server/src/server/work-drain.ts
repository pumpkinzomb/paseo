/** Tracks admitted async work until settlement; closing permanently rejects ingress. */
export function createWorkDrain() {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("Work drain is closed"));
      const promise = Promise.resolve().then(work);
      pending.add(promise);
      void promise.then(
        () => {
          return pending.delete(promise);
        },
        (error) => {
          failures.push(error);
          return pending.delete(promise);
        },
      );
      return promise;
    },
    recordFailure(error: unknown) {
      failures.push(error);
    },
    async close(): Promise<void> {
      closed = true;
      while (pending.size) await Promise.allSettled(pending);
      if (failures.length)
        throw new AggregateError(failures, "Tracked work failed before drain completion");
    },
  };
}
