export interface CommitAttempt {
  isTrusted: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}
/** Terminal input barrier: only an authoritative native abort/ACK may reopen admission. */
export function createRendererCommitSeal(options: {
  cancel(reason: "input-during-commit" | "commit-seal-timeout"): Promise<void>;
  cancellationFailed?(): void;
  timeoutMs?: number;
}) {
  let sealed = false;
  let generation = 0;
  let cancelling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    sealed = false;
    generation++;
    cancelling = false;
    clearTimeout(timer);
    timer = undefined;
  };
  function cancel(reason: "input-during-commit" | "commit-seal-timeout") {
    if (cancelling) return;
    cancelling = true;
    const current = generation;
    let acknowledgment: Promise<void>;
    try {
      acknowledgment = options.cancel(reason);
    } catch {
      acknowledgment = Promise.reject(new Error("cancel-failed"));
    }
    void acknowledgment.then(
      () => {
        if (generation === current) release();
        return undefined;
      },
      () => {
        if (generation === current) {
          cancelling = false;
          options.cancellationFailed?.();
        }
      },
    );
  }
  return {
    get sealed() {
      return sealed;
    },
    seal() {
      if (sealed) return;
      sealed = true;
      generation++;
      timer = setTimeout(() => {
        if (sealed) cancel("commit-seal-timeout");
      }, options.timeoutMs ?? 15000);
    },
    intercept(event: CommitAttempt): boolean {
      if (!sealed || !event.isTrusted) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel("input-during-commit");
      return true;
    },
    release,
  };
}
