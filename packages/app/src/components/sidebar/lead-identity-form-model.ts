export function openLeadIdentityForm(initial: string) {
  let state = {
    text: initial,
    saved: initial,
    saving: false,
    error: null as string | null,
    savedNotice: false,
    resetKey: 0,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setText(text: string) {
      if (!state.saving) publish({ text, error: null, savedNotice: false });
    },
    async save(persist: (text: string, previous: string) => Promise<string>, reset = false) {
      if (state.saving) return;
      if (!reset && (!state.text.trim() || state.text.length > 12000)) {
        publish({ error: "invalid" });
        return;
      }
      publish({ saving: true, error: null, savedNotice: false });
      try {
        const saved = await persist(reset ? "" : state.text, state.saved);
        publish({ text: saved, saved, savedNotice: true, resetKey: state.resetKey + 1 });
      } catch (error) {
        publish({
          error: error instanceof Error && error.message === "conflict" ? "conflict" : "failed",
        });
      } finally {
        publish({ saving: false });
      }
    },
  };
}
