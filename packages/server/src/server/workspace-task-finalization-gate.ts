/** A scoped, synchronous admission fence; unrelated rooms and leads keep running. */
export class WorkspaceTaskFinalizationGate {
  private readonly agents = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly admissions = new Map<string, number>();
  private readonly active = new Map<string, { controller: AbortController; committed: boolean }>();
  private readonly canceledCompletions = new Set<string>();
  isCompletionCanceled(id: string) {
    return this.canceledCompletions.has(id);
  }
  private readonly completionIds = new Map<string, string>();
  completionId(workspaceId: string) {
    return this.completionIds.get(workspaceId);
  }
  bindCompletion(workspaceId: string, id: string) {
    this.completionIds.set(workspaceId, id);
  }
  assertCompletionSupport?: () => void;
  completionCanceled?: (id: string) => Promise<boolean>;
  onInvalidated?: (workspaceId: string) => void;

  watch(workspaceId: string, agentIds: readonly string[]) {
    for (const id of agentIds) this.agents.set(id, workspaceId);
  }

  revision(workspaceId: string) {
    return this.revisions.get(workspaceId) ?? 0;
  }

  admit(workspaceId: string) {
    this.workspaceActivity(workspaceId);
    this.admissions.set(workspaceId, (this.admissions.get(workspaceId) ?? 0) + 1);
    let released = false;
    return () => {
      if (!released) this.admissions.set(workspaceId, (this.admissions.get(workspaceId) ?? 1) - 1);
      released = true;
    };
  }

  assertSettled(workspaceId: string) {
    if (this.admissions.get(workspaceId)) throw new Error("Task activity admission is pending");
  }

  agentActivity(agentId: string) {
    const workspaceId = this.agents.get(agentId);
    if (workspaceId) this.workspaceActivity(workspaceId);
  }

  workspaceActivity(workspaceId: string) {
    this.revisions.set(workspaceId, this.revision(workspaceId) + 1);
    const active = this.active.get(workspaceId);
    if (!active?.committed) {
      const id = this.completionIds.get(workspaceId);
      if (id) this.canceledCompletions.add(id);
      this.onInvalidated?.(workspaceId);
      // Successful synchronous revocation already persisted the marker. Later prompts need no fsync.
      if (id) this.completionIds.delete(workspaceId);
    }
    if (!active) return;
    if (!active.committed) active.controller.abort();
    throw new Error("Task finalization interrupted by new work. Retry after it settles.");
  }

  enter(workspaceId: string) {
    this.assertSettled(workspaceId);
    if (this.active.has(workspaceId)) throw new Error("Task finalization is already running");
    const state = { controller: new AbortController(), committed: false };
    this.active.set(workspaceId, state);
    return {
      signal: state.controller.signal,
      commit: () => {
        state.controller.signal.throwIfAborted();
        state.committed = true;
      },
      close: () => {
        if (this.active.get(workspaceId) === state) this.active.delete(workspaceId);
      },
    };
  }
}
