import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "./validated-persist-storage";

class MemoryStorage implements StateStorage {
  readonly values = new Map<string, string>();

  getItem(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value);
  }

  removeItem(name: string): void {
    this.values.delete(name);
  }
}

const StateSchema = z.strictObject({ enabled: z.boolean() });

describe("createValidatedPersistStorage", () => {
  it.each([
    ["malformed JSON", "{"],
    ["invalid state", JSON.stringify({ state: { enabled: "yes" }, version: 1 })],
    ["unknown state fields", JSON.stringify({ state: { enabled: true, extra: true }, version: 1 })],
    [
      "unknown envelope fields",
      JSON.stringify({ state: { enabled: true }, version: 1, extra: true }),
    ],
  ])("clears %s", async (_label, stored) => {
    const backing = new MemoryStorage();
    backing.values.set("settings", stored);
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toBeNull();
    expect(backing.values.has("settings")).toBe(false);
  });

  it("returns schema-validated state", async () => {
    const backing = new MemoryStorage();
    backing.values.set("settings", JSON.stringify({ state: { enabled: true }, version: 1 }));
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toEqual({
      state: { enabled: true },
      version: 1,
    });
  });

  it("clears a value rejected by the schema before writing", async () => {
    const backing = new MemoryStorage();
    backing.values.set("settings", JSON.stringify({ state: { count: 1 } }));
    const storage = createValidatedPersistStorage(
      backing,
      z.strictObject({ count: z.number().finite() }),
    );

    await storage.setItem("settings", { state: { count: Number.NaN } });

    expect(backing.values.has("settings")).toBe(false);
  });
});

it("skips repeated immutable states only when requested", async () => {
  let writes = 0;
  const backing: StateStorage = {
    getItem: () => null,
    setItem: () => {
      writes += 1;
    },
    removeItem: () => {},
  };
  const value = { state: { enabled: true }, version: 1 };
  const regular = createValidatedPersistStorage(backing, StateSchema);
  await regular.setItem("regular", value);
  await regular.setItem("regular", value);
  expect(writes).toBe(2);

  const deduplicated = createValidatedPersistStorage(backing, StateSchema, { skipUnchanged: true });
  await deduplicated.setItem("first", value);
  await deduplicated.setItem("first", { ...value });
  expect(writes).toBe(3);
  await deduplicated.setItem("second", value);
  expect(writes).toBe(4);
  await deduplicated.setItem("first", { ...value, version: 2 });
  expect(writes).toBe(5);
});

it("retries an unchanged state after a failed save", async () => {
  let attempts = 0;
  const backing = new MemoryStorage();
  const storage = createValidatedPersistStorage(
    {
      getItem: (name) => backing.getItem(name),
      setItem: (name, value) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("storage unavailable"));
        backing.setItem(name, value);
      },
      removeItem: (name) => backing.removeItem(name),
    },
    StateSchema,
    { skipUnchanged: true },
  );
  const value = { state: { enabled: true }, version: 1 };
  await expect(storage.setItem("layout", value)).rejects.toThrow("storage unavailable");
  await storage.setItem("layout", value);
  expect(attempts).toBe(2);
  expect(backing.getItem("layout")).toBe(JSON.stringify(value));
});

it("saves the same state again after removal or rehydration clears invalid storage", async () => {
  const backing = new MemoryStorage();
  const storage = createValidatedPersistStorage(backing, StateSchema, { skipUnchanged: true });
  const value = { state: { enabled: true }, version: 1 };
  await storage.setItem("layout", value);
  await storage.removeItem("layout");
  await storage.setItem("layout", value);
  expect(backing.getItem("layout")).toBe(JSON.stringify(value));

  backing.values.set("layout", "{");
  await expect(storage.getItem("layout")).resolves.toBeNull();
  await storage.setItem("layout", value);
  expect(backing.getItem("layout")).toBe(JSON.stringify(value));
});

it("checkpoint barrier waits for pending removals so readback cannot race a late delete", async () => {
  const { waitForValidatedPersistWrites } = await import("./validated-persist-storage");
  let release!: () => void;
  let saved: string | null = JSON.stringify({ state: { enabled: true }, version: 0 });
  const storage = createValidatedPersistStorage(
    {
      getItem: () => saved,
      setItem: (_name, value) => {
        saved = value;
      },
      removeItem: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        saved = null;
      },
    },
    StateSchema,
  );
  const removal = storage.removeItem("removal-regression");
  let done = false;
  const barrier = waitForValidatedPersistWrites("removal-regression").then(() => {
    done = true;
    return undefined;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await removal;
  await barrier;
  expect(saved).toBeNull();
});
