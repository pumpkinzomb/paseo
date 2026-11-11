import { createRendererCommitSeal } from "./commit-seal";
import { hasUncheckpointedFormInput } from "./browser-url-input";
import { Button } from "@/components/ui/button";
import { collectStoreUpdateBlockers } from "./blockers";
import { useEffect, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PersistStorage } from "zustand/middleware";
import { getIsElectron, isWeb } from "@/constants/platform";
import { type DesktopDevUpdateBridge } from "@/desktop/host";
import { useDraftStore, flushDraftPersistStorageStrict } from "@/stores/draft-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
import { useBrowserStore } from "@/desktop/browser/store";
import { useWorkspaceBrowserStore } from "@/desktop/browser/workspace-store";
import {
  getLastWorkspaceSelection,
  flushLastWorkspaceSelectionStrict,
  subscribeLastWorkspaceSelection,
  getIsLastWorkspaceSelectionHydrated,
} from "@/stores/navigation-active-workspace-store";
import { LAST_WORKSPACE_SELECTION_STORAGE_KEY } from "@/stores/last-workspace-selection";
import {
  getModifiedPanelCheckpoint,
  subscribeAllPanelInstanceAttributes,
} from "@/panels/panel-instance-attributes";
import { waitForValidatedPersistWrites } from "@/storage/validated-persist-storage";
import { canonicalCheckpoint, verifyCheckpoint } from "./checkpoint";
import { getUpdateTransientBlockers, subscribeUpdateTransientState } from "./transient-state";

type Status = Parameters<Parameters<DesktopDevUpdateBridge["onStatus"]>[0]>[0];
function persistentSource<T, P>(store: {
  getState(): T;
  persist: {
    hasHydrated(): boolean;
    getOptions(): {
      name?: string;
      version?: number;
      partialize?: (state: T) => P;
      storage?: PersistStorage<P>;
    };
  };
}) {
  const options = store.persist.getOptions();
  const name = options.name;
  if (!name || !options.storage || !options.partialize) throw new Error("Persistence unavailable");
  const storage = options.storage;
  const project = options.partialize;
  return {
    name,
    hydrated: () => store.persist.hasHydrated(),
    capture: () => ({ state: project(store.getState()), version: options.version ?? 0 }),
    flush: async () => {
      await waitForValidatedPersistWrites(name);
      await storage.setItem(name, {
        state: project(store.getState()),
        version: options.version ?? 0,
      });
    },
    read: async () => {
      await waitForValidatedPersistWrites(name);
      // Read the backing value without invoking hydration/repair or suppressing concurrent writes.
      const raw = await AsyncStorage.getItem(name);
      return raw === null ? null : (JSON.parse(raw) as unknown);
    },
  };
}

export function SupervisedUpdateCheckpoint() {
  const [status, setStatus] = useState<Status | null>(null);
  const [interruptedInput, setInterruptedInput] = useState(false);
  useEffect(() => {
    if (
      !isWeb ||
      !getIsElectron() ||
      process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL !== "supervised-runtime"
    )
      return;
    const bridge = window.paseoDesktop?.devUpdate;
    if (!bridge) return;
    let revision = 0;
    let lastActivity = Date.now();
    let composing = false;
    const unknownInputs = new Set<Element>();
    const invalidate = (reason: string) => {
      revision++;
      bridge.activity(reason);
    };
    const seal = createRendererCommitSeal({
      cancel: (reason) => {
        invalidate(reason);
        if (reason === "input-during-commit") setInterruptedInput(true);
        setStatus({ state: "canceling", blockers: [reason] });
        return bridge.cancel();
      },
      cancellationFailed: () => setStatus({ state: "canceling", blockers: ["cancel-ack-failed"] }),
    });
    const activity = (event: Event) => {
      if (!event.isTrusted) return;
      if (seal.intercept(event)) return;
      lastActivity = Date.now();
      if (event.type === "compositionstart") composing = true;
      if (event.type === "compositionend") composing = false;
      if (
        (event.type === "input" || event.type === "change") &&
        event.target instanceof Element &&
        !event.target.closest('[data-testid="message-input-root"]')
      )
        unknownInputs.add(event.target);
      invalidate("renderer-user-activity");
    };
    const events = [
      "beforeinput",
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "click",
      "submit",
      "keydown",
      "input",
      "change",
      "paste",
      "drop",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ];
    events.forEach((name) =>
      document.addEventListener(name, activity, { capture: true, passive: false }),
    );
    const sources = [
      persistentSource(useDraftStore),
      persistentSource(useWorkspaceLayoutStore),
      persistentSource(useBrowserStore),
      persistentSource(useWorkspaceBrowserStore),
    ];
    const stores = [
      [useDraftStore, "renderer-drafts-changed"],
      [useWorkspaceLayoutStore, "renderer-layout-changed"],
      [useBrowserStore, "renderer-browser-changed"],
      [useWorkspaceBrowserStore, "renderer-workspace-browser-changed"],
      [useCreateFlowStore, "renderer-create-flow-changed"],
      [useWorkspaceDraftSubmissionStore, "renderer-submission-changed"],
      [useWorkspaceAttachmentsStore, "renderer-attachments-changed"],
      [useAddProjectFlowStore, "renderer-add-project-changed"],
      [useWorkspaceSetupStore, "renderer-setup-changed"],
    ] as const;
    const unsubscribes = stores.map(([store, reason]) => store.subscribe(() => invalidate(reason)));
    unsubscribes.push(
      subscribeLastWorkspaceSelection(() => invalidate("workspace-selection-changed")),
      subscribeAllPanelInstanceAttributes(() => invalidate("panel-changed")),
      subscribeUpdateTransientState(() => invalidate("transient-state-changed")),
    );
    const blockers = () => {
      const result = getUpdateTransientBlockers();
      if (!/^\/h\/[^/]+\/workspace\/[^/]+\/?$/.test(location.pathname))
        result.push("non-workspace-screen");
      if (useWorkspaceSetupStore.getState().pendingWorkspaceSetup)
        result.push("workspace-setup-pending");
      if (composing || Date.now() - lastActivity < 10000) result.push("recent-user-activity");
      if (sources.some((source) => !source.hydrated()) || !getIsLastWorkspaceSelectionHydrated())
        result.push("state-not-hydrated");
      const submission = useWorkspaceDraftSubmissionStore.getState();
      const layout = useWorkspaceLayoutStore.getState();
      result.push(
        ...collectStoreUpdateBlockers({
          metadataByDraftKey: useDraftStore.getState().metadataByDraftKey,
          pendingCreateByDraftId: useCreateFlowStore.getState().pendingByDraftId,
          pendingSubmissionByDraftId: submission.pendingByDraftId,
          creationByDraftId: submission.creationByDraftId,
          setupByDraftId: submission.setupByDraftId,
          attachmentsByScope: useWorkspaceAttachmentsStore.getState().attachmentsByScope,
          pendingOpenByWorkspace: layout.pendingOpenByWorkspace,
          sheetsByWorkspace: layout.sheetsByWorkspace,
          modifiedPanelCount: getModifiedPanelCheckpoint().count,
        }),
      );
      if (
        Object.keys(layout.layoutByWorkspace).some((key) =>
          layout
            .getWorkspaceTabs(key)
            .some(
              (tab) =>
                tab.target.kind === "plugin" ||
                tab.target.kind === "setup" ||
                tab.target.kind === "commit_diff",
            ),
        )
      )
        result.push("uncheckpointed-panel-state");
      if (
        useAddProjectFlowStore.getState().request ||
        document.querySelector('[role="dialog"], [aria-modal="true"]')
      )
        result.push("dialog-open");
      if (
        hasUncheckpointedFormInput(
          document,
          unknownInputs,
          useBrowserStore.getState().browsersById,
          new Set(Object.values(useDraftStore.getState().drafts).map((draft) => draft.input.text)),
        )
      )
        result.push("uncheckpointed-form-input");
      return result;
    };
    const capture = () =>
      canonicalCheckpoint({
        stores: sources.map((source) => ({ name: source.name, value: source.capture() })),
        selection: getLastWorkspaceSelection(),
        route: location.href,
      });
    unsubscribes.push(
      bridge.onStatus((next) => {
        if (!["ready", "prepared", "committing"].includes(next.state)) seal.release();
        setStatus(next);
      }),
      bridge.onPrepare(async (request) => {
        if (request.phase === "abort") {
          seal.release();
          return { blockers: ["update-canceled"] };
        }
        const committing = request.phase === "commit";
        if (committing) {
          seal.seal();
          setStatus({ state: "committing" });
        } else {
          seal.release();
          setInterruptedInput(false);
        }
        const before = blockers();
        if (before.length) {
          seal.release();
          return { blockers: before };
        }
        const initialRevision = revision;
        try {
          const snapshot = await verifyCheckpoint({
            capture,
            revision: () => revision,
            flush: async () => {
              await Promise.all(sources.map((source) => source.flush()));
              await flushDraftPersistStorageStrict();
              await flushLastWorkspaceSelectionStrict();
            },
            read: async () =>
              canonicalCheckpoint({
                stores: await Promise.all(
                  sources.map(async (source) => ({
                    name: source.name,
                    value: await source.read(),
                  })),
                ),
                selection: JSON.parse(
                  (await AsyncStorage.getItem(LAST_WORKSPACE_SELECTION_STORAGE_KEY)) ?? "null",
                ) as unknown,
                route: location.href,
              }),
          });
          const digest = Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot)),
            ),
          )
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const after = blockers();
          if (after.length || revision !== initialRevision || (committing && !seal.sealed)) {
            seal.release();
            return { blockers: [...after, "checkpoint-changed"] };
          }
          return {
            blockers: [],
            receipt: {
              schemaVersion: 1 as const,
              ...(committing ? { sealed: true as const } : {}),
              digest,
              activityEpoch: request.activityEpoch,
              revision,
              capturedAt: Date.now(),
            },
          };
        } catch {
          seal.release();
          return { blockers: ["checkpoint-not-durable-or-timed-out"] };
        }
      }),
    );
    return () => {
      revision++;
      seal.release();
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      events.forEach((name) => document.removeEventListener(name, activity, true));
    };
  }, []);
  if (
    !status ||
    !["countdown", "blocked", "preparing", "committing", "canceling"].includes(status.state)
  )
    return null;
  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.text}>{updateNotice(status, interruptedInput)}</Text>
      <Button onPress={cancelRestart} variant="secondary">
        Cancel restart
      </Button>
    </View>
  );
}

function updateNotice(status: Status, interruptedInput: boolean): string {
  if (status.state === "committing")
    return "Saving your work for restart. Any input cancels the restart.";
  if (status.state === "canceling") {
    if (status.blockers?.includes("cancel-ack-failed"))
      return "Cancellation is not confirmed. Input remains paused; press Cancel restart to retry.";
    return "Canceling restart. Input is briefly paused; please try again when cancellation finishes.";
  }
  if (interruptedInput && status.state === "blocked")
    return "Restart canceled. Please repeat your last input.";
  if (status.state === "countdown")
    return `Update ready. Restarting in ${status.countdownSeconds ?? 0}s. Your saved work will reopen.`;
  return `Update waiting: ${status.blockers?.join(", ") || "checking saved work"}`;
}

function cancelRestart() {
  void window.paseoDesktop?.devUpdate?.cancel();
}
const styles = StyleSheet.create({
  notice: {
    position: "absolute",
    bottom: 16,
    right: 16,
    maxWidth: 360,
    padding: 12,
    backgroundColor: "#20242b",
    zIndex: 10000,
  },
  text: { color: "white" },
  cancel: { color: "#99caff", paddingTop: 8 },
});
