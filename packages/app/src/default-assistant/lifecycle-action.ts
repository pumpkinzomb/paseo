import type { AssistantLifecycleAction } from "./lifecycle-policy";

/** Confirmation is bound to one invocation; dismissal or navigation cannot trigger a mutation. */
export async function confirmAssistantLifecycle<T>(input: {
  action: AssistantLifecycleAction;
  confirm: () => Promise<boolean>;
  stillActive: () => boolean;
  mutate: (action: AssistantLifecycleAction) => Promise<T>;
}): Promise<T | null> {
  if (!(await input.confirm()) || !input.stillActive()) return null;
  return input.mutate(input.action);
}
