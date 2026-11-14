import { create } from "zustand";
import type { DevelopmentReviewIdentity } from "@/workspace/file-open";
export const useDevelopmentReviewSelection = create<{
  values: Record<string, DevelopmentReviewIdentity | undefined>;
  select: (key: string, value?: DevelopmentReviewIdentity) => void;
}>((set) => ({
  values: {},
  select: (key, value) => set((state) => ({ values: { ...state.values, [key]: value } })),
}));
export function selectedDevelopmentReview(
  workspaceKey: string | null,
): DevelopmentReviewIdentity | undefined {
  return Object.values(useDevelopmentReviewSelection.getState().values).find(
    (value) => value && `${value.serverId}:${value.parentWorkspaceId}` === workspaceKey,
  );
}
