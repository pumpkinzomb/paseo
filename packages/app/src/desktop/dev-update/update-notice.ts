export function updateNoticeKey(
  state: string,
  blockers: readonly string[] = [],
  interrupted = false,
): string {
  if (state === "committing") return "saving";
  if (state === "canceling")
    return blockers.includes("cancel-ack-failed") ? "cancelFailed" : "canceling";
  if (interrupted && state === "blocked") return "interrupted";
  if (state === "countdown") return "countdown";
  if (blockers.some((value) => value.startsWith("browser-"))) return "browser";
  if (blockers.includes("recent-user-activity")) return "activity";
  return blockers.length ? "blocked" : "savingWait";
}
