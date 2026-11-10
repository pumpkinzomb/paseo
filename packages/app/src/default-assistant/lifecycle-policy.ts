export type AssistantLifecycleAction = "archive" | "restore" | "delete";
export function assistantLifecycleActions(archived: boolean): AssistantLifecycleAction[] {
  return [archived ? "restore" : "archive", "delete"];
}
export function assistantLifecycleBusy(status?: string): boolean {
  return status === "running" || status === "initializing";
}
