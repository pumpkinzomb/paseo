import { describe, expect, it } from "vitest";
import {
  createLastWorkspaceSelectionStore,
  type ActiveWorkspaceSelection,
  type LastWorkspaceSelectionStorage,
} from "./last-workspace-selection";

class DelayedWorkspaceSelectionStorage implements LastWorkspaceSelectionStorage {
  private finishRead: (value: string | null) => void = () => {};
  private readonly pendingRead = new Promise<string | null>((resolve) => {
    this.finishRead = resolve;
  });
  private saved: string | null = null;

  read(): Promise<string | null> {
    return this.pendingRead;
  }

  async write(value: string): Promise<void> {
    this.saved = value;
  }

  async clear(): Promise<void> {
    this.saved = null;
  }

  finishHydrationWith(selection: ActiveWorkspaceSelection | null) {
    this.finishRead(selection ? JSON.stringify(selection) : null);
  }

  getSavedSelection(): ActiveWorkspaceSelection | null {
    if (!this.saved) return null;
    const parsed: unknown = JSON.parse(this.saved);
    if (!parsed || typeof parsed !== "object") return null;
    return this.saved ? JSON.parse(this.saved) : null;
  }
}

describe("last workspace selection", () => {
  it("hydrates the saved workspace selection", async () => {
    const storage = new DelayedWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    const hydration = store.hydrate();

    storage.finishHydrationWith({ serverId: "server-saved", workspaceId: "workspace-saved" });
    await hydration;

    expect(store.getSelection()).toEqual({
      serverId: "server-saved",
      workspaceId: "workspace-saved",
    });
    expect(store.isHydrated()).toBe(true);
  });

  it("keeps a newer workspace selection when storage hydration finishes late", async () => {
    const storage = new DelayedWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    const hydration = store.hydrate();

    store.remember({ serverId: "server-new", workspaceId: "workspace-new" });
    storage.finishHydrationWith({ serverId: "server-old", workspaceId: "workspace-old" });
    await hydration;

    expect(store.getSelection()).toEqual({
      serverId: "server-new",
      workspaceId: "workspace-new",
    });
    expect(storage.getSavedSelection()).toEqual({
      serverId: "server-new",
      workspaceId: "workspace-new",
    });
  });
});

it("serializes selection writes and strict flush waits for the latest", async () => {
  let release!: () => void;
  let saved: string | null = null;
  const writes: string[] = [];
  const store = createLastWorkspaceSelectionStore({
    read: async () => saved,
    clear: async () => {
      saved = null;
    },
    write: async (value) => {
      writes.push(value);
      if (writes.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      saved = value;
    },
  });
  store.remember({ serverId: "host", workspaceId: "first" });
  store.remember({ serverId: "host", workspaceId: "latest" });
  expect(writes).toHaveLength(1);
  let done = false;
  const flush = store.flushStrict().then(() => {
    done = true;
    return null;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await flush;
  expect(saved).toBe(JSON.stringify({ serverId: "host", workspaceId: "latest" }));
});

it("strict flush reports a failed selection write", async () => {
  const store = createLastWorkspaceSelectionStore({
    read: async () => null,
    clear: async () => {},
    write: async () => {
      throw new Error("storage-unavailable");
    },
  });
  store.remember({ serverId: "host", workspaceId: "keep-selection" });
  await expect(store.flushStrict()).rejects.toThrow("storage-unavailable");
  expect(store.getSelection()).toEqual({ serverId: "host", workspaceId: "keep-selection" });
});
