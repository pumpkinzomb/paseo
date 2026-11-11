import type { PersistStorage } from "zustand/middleware";

export const DRAFT_PERSIST_INTERVAL_MS = 200;
export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface DraftPersistStorage<T> extends PersistStorage<T> {
  flush: () => Promise<void>;
  flushStrict: () => Promise<void>;
}

let nextSystemTimerId = 0;
const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
const systemScheduler: PersistenceScheduler = {
  now: Date.now,
  schedule: (callback, delayMs) => {
    const id = nextSystemTimerId++;
    systemTimers.set(
      id,
      setTimeout(() => {
        systemTimers.delete(id);
        callback();
      }, delayMs),
    );
    return id;
  },
  cancel: (handle) => {
    if (typeof handle !== "number") return;
    const timer = systemTimers.get(handle);
    if (timer === undefined) return;
    clearTimeout(timer);
    systemTimers.delete(handle);
  },
};

export function createDraftPersistStorage<T>(
  storage: PersistStorage<T>,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T>;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T> | undefined;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler: PersistenceScheduler = systemScheduler,
): DraftPersistStorage<T> | undefined {
  if (!storage) {
    return undefined;
  }

  let pending: { name: string; value: Parameters<typeof storage.setItem>[1] } | null = null;
  let timer: unknown = null;
  let lastWriteAt = -Infinity;

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  };
  let inFlight: Promise<void> | null = null;
  let failure: unknown = null;
  const drain = (): Promise<void> => {
    cancelTimer();
    if (inFlight) return inFlight.then(drain);
    const write = pending;
    pending = null;
    if (!write) return Promise.resolve();
    lastWriteAt = scheduler.now();
    let result: unknown;
    try {
      result = storage.setItem(write.name, write.value);
    } catch (error) {
      failure = error;
      return Promise.resolve();
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      const operation = Promise.resolve(result)
        .then(
          () => {
            failure = null;
            return undefined;
          },
          (error: unknown) => {
            failure = error;
          },
        )
        .finally(() => {
          if (inFlight === operation) inFlight = null;
        });
      inFlight = operation;
      return operation.then(drain);
    }
    failure = null;
    return Promise.resolve();
  };
  const flushStrict = async (): Promise<void> => {
    await drain();
    if (failure !== null) throw failure;
  };
  const flush = async (): Promise<void> => {
    try {
      await flushStrict();
    } catch (error) {
      console.warn("[DraftStore] Failed to persist draft checkpoint", error);
    }
  };

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      const delay = DRAFT_PERSIST_INTERVAL_MS - (scheduler.now() - lastWriteAt);
      if (delay <= 0) {
        return flush();
      }
      timer ??= scheduler.schedule(() => {
        void flush();
      }, delay);
    },
    removeItem: (name) => {
      cancelTimer();
      pending = null;
      lastWriteAt = scheduler.now();
      const remove = () => storage.removeItem(name);
      const result = inFlight ? inFlight.then(remove) : remove();
      if (result && typeof (result as Promise<void>).then === "function") {
        const operation = Promise.resolve(result)
          .then(
            () => {
              failure = null;
              return undefined;
            },
            (error: unknown) => {
              failure = error;
            },
          )
          .finally(() => {
            if (inFlight === operation) inFlight = null;
          });
        inFlight = operation;
        return operation;
      }
      return result;
    },
    flush,
    flushStrict,
  };
}
