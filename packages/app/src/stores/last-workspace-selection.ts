import { z } from "zod";

export interface ActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

export const LAST_WORKSPACE_SELECTION_STORAGE_KEY = "paseo:last-workspace-route-selection";

export interface LastWorkspaceSelectionStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

const ActiveWorkspaceSelectionSchema: z.ZodType<ActiveWorkspaceSelection> = z.strictObject({
  serverId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
});

function normalizeWorkspaceSelection(input: unknown): ActiveWorkspaceSelection | null {
  const result = ActiveWorkspaceSelectionSchema.safeParse(input);
  return result.success ? result.data : null;
}

function parseStoredWorkspaceSelection(stored: string | null): ActiveWorkspaceSelection | null {
  if (!stored) {
    return null;
  }
  try {
    return normalizeWorkspaceSelection(JSON.parse(stored));
  } catch {
    return null;
  }
}

export function createLastWorkspaceSelectionStore(storage: LastWorkspaceSelectionStorage) {
  let selection: ActiveWorkspaceSelection | null = null;
  let hydrated = false;
  let hydrationPromise: Promise<void> | null = null;
  let revision = 0;
  const listeners = new Set<() => void>();
  let pendingWrite: Promise<void> | null = null;
  let writeFailure: unknown = null;
  function enqueueWrite(write: () => Promise<void>): void {
    const run = async () => {
      try {
        await write();
        writeFailure = null;
      } catch (error) {
        writeFailure = error;
      }
    };
    const operation = (pendingWrite ? pendingWrite.then(run) : run()).finally(() => {
      if (pendingWrite === operation) pendingWrite = null;
    });
    pendingWrite = operation;
  }
  async function flushStrict(): Promise<void> {
    for (let operation = pendingWrite; operation; operation = pendingWrite) await operation;
    if (writeFailure !== null) throw writeFailure;
  }

  function notifyListeners() {
    for (const listener of listeners) {
      listener();
    }
  }

  function remember(next: ActiveWorkspaceSelection) {
    const normalized = normalizeWorkspaceSelection(next);
    if (!normalized) {
      return;
    }
    if (
      selection?.serverId === normalized.serverId &&
      selection.workspaceId === normalized.workspaceId
    ) {
      return;
    }
    selection = normalized;
    revision += 1;
    notifyListeners();
    // workspaceId is opaque; do not parse this persisted selection back into a path.
    enqueueWrite(() => storage.write(JSON.stringify(normalized)));
  }

  function hydrate(): Promise<void> {
    if (hydrationPromise) {
      return hydrationPromise;
    }
    const hydrationRevision = revision;
    hydrationPromise = storage
      .read()
      .then((stored) => {
        if (revision === hydrationRevision) {
          selection = parseStoredWorkspaceSelection(stored);
          if (stored !== null && selection === null) {
            enqueueWrite(() => storage.clear());
          }
        }
        return undefined;
      })
      .catch(() => {
        if (revision === hydrationRevision) {
          selection = null;
        }
      })
      .finally(() => {
        hydrated = true;
        notifyListeners();
      });
    return hydrationPromise;
  }

  return {
    getSelection: () => selection,
    flushStrict,
    hydrate,
    isHydrated: () => hydrated,
    remember,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
