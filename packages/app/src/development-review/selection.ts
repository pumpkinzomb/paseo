import { create } from "zustand";
import type { DevelopmentReviewIdentity } from "@/workspace/file-open";
export const useDevelopmentReviewSelection = create<{
  values: Record<string, DevelopmentReviewIdentity | undefined>;
  select: (key: string, value?: DevelopmentReviewIdentity) => void;
}>((set) => ({
  values: {},
  select: (key, value) => set((state) => ({ values: { ...state.values, [key]: value } })),
}));
