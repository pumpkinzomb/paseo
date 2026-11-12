import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface NativeVoicePreference {
  voice: string;
  setVoice: (voice: string) => void;
}
// A device preference for future calls, independent of daemon API TTS.
export const useNativeVoicePreference = create<NativeVoicePreference>()(
  persist<NativeVoicePreference, [], [], { voice: string }>(
    (set) => ({ voice: "", setVoice: (voice) => set({ voice }) }),
    {
      name: "native-call-voice",
      storage: createValidatedPersistStorage(AsyncStorage, z.object({ voice: z.string().max(64) })),
      partialize: ({ voice }) => ({ voice }),
    },
  ),
);
