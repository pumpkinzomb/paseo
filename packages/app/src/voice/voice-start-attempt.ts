/** A dismissed setup must never enable the microphone when readiness arrives later. */
export function createVoiceStartAttempt(deps: {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isActive: () => boolean;
}) {
  let cancelled = false;
  let starting = false;
  return {
    cancel() {
      cancelled = true;
    },
    async start(): Promise<boolean> {
      if (cancelled || starting) return false;
      starting = true;
      try {
        await deps.start();
        if (cancelled) {
          if (deps.isActive()) await deps.stop();
          return false;
        }
        return true;
      } catch (error) {
        starting = false;
        throw error;
      }
    },
  };
}
