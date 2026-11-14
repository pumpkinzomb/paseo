export type WorkspaceSetupOperation = (signal: AbortSignal) => Promise<void>;

interface WorkspaceSetupRun {
  controller: AbortController;
  completion: Promise<void>;
}

export class WorkspaceSetupRuntime {
  beforeStart?: (workspaceId: string) => void;
  private readonly runs = new Map<string, WorkspaceSetupRun>();
  isRunning(workspaceId: string) {
    return this.runs.has(workspaceId);
  }

  start(workspaceId: string, operation: WorkspaceSetupOperation): void {
    this.beforeStart?.(workspaceId);
    const controller = new AbortController();
    const run: WorkspaceSetupRun = {
      controller,
      completion: Promise.resolve(),
    };
    this.runs.set(workspaceId, run);
    run.completion = Promise.resolve()
      .then(() => operation(controller.signal))
      .catch(() => undefined)
      .finally(() => {
        if (this.runs.get(workspaceId) === run) {
          this.runs.delete(workspaceId);
        }
      });
  }

  async stop(workspaceId: string): Promise<void> {
    const run = this.runs.get(workspaceId);
    if (!run) {
      return;
    }
    run.controller.abort();
    await run.completion;
  }
}
