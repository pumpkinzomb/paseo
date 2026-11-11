import { useSyncExternalStore } from "react";
import { useUpdateTransientBlocker } from "@/desktop/dev-update/transient-state";
import type { VoiceRuntime } from "./voice-runtime";

/** Voice survives composer navigation, so update safety follows the global runtime. */
export function useVoiceUpdateBlocker(runtime: VoiceRuntime): void {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  useUpdateTransientBlocker(
    "voice-session-active",
    snapshot.isVoiceMode || snapshot.isVoiceSwitching,
  );
}
