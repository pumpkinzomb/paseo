import {
  AssistantConversationSchema,
  type AssistantConversation,
  type AssistantEnsureRequestSchema,
} from "@getpaseo/protocol/messages";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const SelectionSchema = z.object({
  currentAgentId: z.string().nullable(),
  requests: z.record(z.string(), z.string()),
  fingerprints: z.record(z.string(), z.string()).optional(),
  conversations: z.record(z.string(), AssistantConversationSchema).default({}),
  agentConversationIds: z.record(z.string(), z.string()).default({}),
});

export function validateAssistantCreationRequest(
  request: z.infer<typeof AssistantEnsureRequestSchema>,
): void {
  if (request.workspaceId && request.newSession !== true)
    throw new Error("Selecting a workspace requires a new assistant conversation.");
  if (request.workspaceId && request.handoff)
    throw new Error("A handoff must keep its source workspace; do not supply workspaceId.");
  const hasWorkspaceOptions =
    request.cwd !== undefined ||
    request.modeId !== undefined ||
    request.providerOptions !== undefined ||
    request.metadata !== undefined;
  if (hasWorkspaceOptions && (!request.workspaceId || request.newSession !== true))
    throw new Error("Project assistant options require a new conversation and workspaceId.");
  const explicitSelection =
    request.provider !== undefined ||
    request.model !== undefined ||
    request.thinkingOptionId !== undefined;
  if ((explicitSelection || request.handoff) && request.newSession !== true)
    throw new Error("Changing assistant settings requires a new conversation.");
}

export interface AssistantSession {
  agent: {
    id: string;
    provider?: string;
    model?: string | null;
    workspaceId?: string;
    createdAt?: string;
    archivedAt?: string | null;
  };
}

interface EnsureInput<T extends AssistantSession> {
  requestId: string;
  newSession: boolean;
  fingerprint?: string;
  sourceAgentId?: string;
  reviewedContext?: string;
  find: (agentId: string) => Promise<T | null>;
  create: (key: string, previousAgentId: string | null) => Promise<T>;
}

/** Serializes selection across client connections; provider work only happens on explicit creation. */
export class DefaultAssistantSelection {
  private tail: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(paseoHome: string) {
    this.file = join(paseoHome, "default-assistant.json");
  }

  ensure<T extends AssistantSession>(input: EnsureInput<T>): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.read();
      const requestedAgentId = input.newSession ? state.requests[input.requestId] : undefined;
      if (requestedAgentId) {
        if (
          input.fingerprint !== undefined &&
          state.fingerprints?.[input.requestId] !== input.fingerprint
        ) {
          throw new Error("Assistant request ID was already used with different settings.");
        }
        const existing = await input.find(requestedAgentId);
        if (!existing || this.isArchived(state, requestedAgentId))
          throw new Error(
            "This assistant session was archived or removed. Start a new conversation.",
          );
        return existing;
      }
      if (
        !input.newSession &&
        state.currentAgentId &&
        !this.isArchived(state, state.currentAgentId)
      ) {
        const existing = await input.find(state.currentAgentId);
        if (existing) return existing;
      }
      const sourceConversation = await this.findHandoffConversation(state, input);
      const result = await input.create(
        `assistant:${input.requestId}`,
        sourceConversation?.activeAgentId ?? state.currentAgentId,
      );
      const conversation = this.register(state, result.agent, sourceConversation?.logicalId);
      const segment = conversation.segments.find((item) => item.agentId === result.agent.id);
      if (segment && input.sourceAgentId && input.reviewedContext !== undefined)
        segment.reviewedContext = input.reviewedContext;
      conversation.activeAgentId = result.agent.id;
      conversation.activeWorkspaceId = result.agent.workspaceId ?? null;
      await writeJsonFileAtomic(this.file, {
        ...state,
        currentAgentId: result.agent.id,
        requests: { ...state.requests, [input.requestId]: result.agent.id },
        fingerprints: {
          ...state.fingerprints,
          ...(input.fingerprint !== undefined ? { [input.requestId]: input.fingerprint } : {}),
        },
      });
      return result;
    });
  }

  private async findHandoffConversation<T extends AssistantSession>(
    state: z.infer<typeof SelectionSchema>,
    input: EnsureInput<T>,
  ): Promise<AssistantConversation | undefined> {
    if (!input.sourceAgentId) return undefined;
    const source = await input.find(input.sourceAgentId);
    if (!source || source.agent.archivedAt)
      throw new Error("The source assistant changed. Review the handoff again.");
    const conversation = this.register(state, source.agent);
    if (conversation.archivedAt || conversation.activeAgentId !== source.agent.id)
      throw new Error("The source assistant changed. Review the handoff again.");
    return conversation;
  }

  remember(agentId: string): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.read();
      if (state.currentAgentId === agentId) return;
      const conversation = state.conversations[state.agentConversationIds[agentId] ?? ""];
      if (conversation?.archivedAt) return;
      if (conversation) {
        conversation.activeAgentId = agentId;
        conversation.activeWorkspaceId =
          conversation.segments.find((segment) => segment.agentId === agentId)?.workspaceId ?? null;
      }
      await writeJsonFileAtomic(this.file, {
        ...state,
        currentAgentId: agentId,
      });
    });
  }

  getConversation(input: {
    agentId?: string;
    logicalId?: string;
    find: (agentId: string) => Promise<AssistantSession | null>;
  }): Promise<AssistantConversation | null> {
    return this.enqueue(async () => {
      const state = await this.read();
      const agentId = input.agentId ?? (input.logicalId ? undefined : state.currentAgentId);
      const logicalId =
        input.logicalId ?? (agentId ? state.agentConversationIds[agentId] : undefined);
      if (logicalId) {
        const conversation = state.conversations[logicalId];
        if (!conversation) return null;
        let changed = false;
        for (const segment of conversation.segments) {
          const session = await input.find(segment.agentId);
          if (!session) continue;
          const model = session.agent.model ?? null;
          if (segment.model !== model) {
            segment.model = model;
            changed = true;
          }
        }
        if (changed) await writeJsonFileAtomic(this.file, state);
        return conversation;
      }
      if (!agentId) return null;
      const session = await input.find(agentId);
      if (!session) return null;
      const conversation = this.register(state, session.agent);
      await writeJsonFileAtomic(this.file, state);
      return conversation;
    });
  }

  /** Serialize lifecycle changes with handoff/selection. Callback must be idempotent. */
  mutateConversation(input: {
    agentId: string;
    action: "archive" | "restore" | "delete";
    find: (agentId: string) => Promise<AssistantSession | null>;
    apply: (agentIds: string[], action: "archive" | "restore" | "delete") => Promise<void>;
  }): Promise<string[]> {
    return this.enqueue(async () => {
      const state = await this.read();
      let conversation = state.conversations[state.agentConversationIds[input.agentId] ?? ""];
      if (!conversation) {
        const session = await input.find(input.agentId);
        if (!session) {
          if (input.action === "delete") return [];
          throw new Error("Assistant conversation not found");
        }
        conversation = this.register(state, session.agent);
      }
      const ids = conversation.segments.map((segment) => segment.agentId);
      await input.apply(ids, input.action);
      if (input.action === "delete") {
        delete state.conversations[conversation.logicalId];
        for (const id of ids) delete state.agentConversationIds[id];
      } else {
        conversation.archivedAt = input.action === "archive" ? new Date().toISOString() : null;
      }
      if (
        input.action !== "restore" &&
        state.currentAgentId &&
        ids.includes(state.currentAgentId)
      ) {
        state.currentAgentId = null;
        // Do not silently resurrect archived conversations. Fall back only to a surviving one.
        for (const candidate of Object.values(state.conversations).toReversed()) {
          if (candidate.archivedAt) continue;
          const surviving = await input.find(candidate.activeAgentId);
          if (surviving && !surviving.agent.archivedAt) {
            state.currentAgentId = candidate.activeAgentId;
            break;
          }
        }
      }
      await writeJsonFileAtomic(this.file, state);
      return ids;
    });
  }

  /** The caller supplies an explicit workspace tree, never an inferred provider relationship. */
  deleteWorkspaceSessions(input: {
    workspaceId: string;
    workspaceIds?: readonly string[];
    expectedAgentIds?: readonly string[];
    list: () => Promise<readonly { id: string; workspaceId?: string }[]>;
    validate: (ids: string[]) => Promise<void>;
    apply: (ids: string[]) => Promise<void>;
  }): Promise<string[]> {
    return this.enqueue(async () => {
      const state = await this.read();
      const records = await input.list();
      const workspaceIds = new Set(input.workspaceIds ?? [input.workspaceId]);
      workspaceIds.add(input.workspaceId);
      const ids = records
        .filter((record) => record.workspaceId && workspaceIds.has(record.workspaceId))
        .map((record) => record.id)
        .sort();
      const selected = new Set(ids);
      const existingIds = new Set(records.map((record) => record.id));
      const conversations = Object.values(state.conversations).filter((conversation) =>
        conversation.segments.some(
          (segment) =>
            selected.has(segment.agentId) ||
            (segment.workspaceId !== null &&
              workspaceIds.has(segment.workspaceId) &&
              !existingIds.has(segment.agentId)),
        ),
      );
      // Never split a logical conversation or silently expand into another sidebar row.
      for (const conversation of conversations) {
        if (
          conversation.segments.some((segment) =>
            records.some((record) => record.id === segment.agentId && !selected.has(record.id)),
          )
        )
          throw new Error(
            "A linked conversation belongs to another workspace. Delete that conversation from its own menu first.",
          );
      }
      if (
        input.expectedAgentIds !== undefined &&
        JSON.stringify([...new Set(input.expectedAgentIds)].sort()) !== JSON.stringify(ids)
      )
        throw new Error("The sessions in this group changed. Reopen Delete and review them again.");
      await input.validate(ids);
      if (input.expectedAgentIds === undefined) return ids;
      await input.apply(ids);
      for (const conversation of conversations) {
        delete state.conversations[conversation.logicalId];
        for (const segment of conversation.segments)
          delete state.agentConversationIds[segment.agentId];
      }
      if (state.currentAgentId && selected.has(state.currentAgentId)) state.currentAgentId = null;
      await writeJsonFileAtomic(this.file, state);
      return ids;
    });
  }

  private isArchived(state: z.infer<typeof SelectionSchema>, agentId: string): boolean {
    return Boolean(state.conversations[state.agentConversationIds[agentId] ?? ""]?.archivedAt);
  }

  private register(
    state: z.infer<typeof SelectionSchema>,
    agent: AssistantSession["agent"],
    existingId?: string,
  ): AssistantConversation {
    const logicalId =
      existingId ??
      state.agentConversationIds[agent.id] ??
      `conversation_${createHash("sha256").update(agent.id).digest("hex").slice(0, 24)}`;
    const conversation = state.conversations[logicalId] ?? {
      logicalId,
      activeAgentId: agent.id,
      activeWorkspaceId: agent.workspaceId ?? null,
      segments: [],
    };
    if (!conversation.segments.some((segment) => segment.agentId === agent.id)) {
      conversation.segments.push({
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        provider: agent.provider ?? "unknown",
        model: agent.model ?? null,
        createdAt: agent.createdAt ?? new Date().toISOString(),
      });
    }
    state.conversations[logicalId] = conversation;
    state.agentConversationIds[agent.id] = logicalId;
    return conversation;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<z.infer<typeof SelectionSchema>> {
    try {
      return SelectionSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {
          currentAgentId: null,
          requests: {},
          conversations: {},
          agentConversationIds: {},
        };
      }
      throw error;
    }
  }
}

const selections = new WeakMap<object, DefaultAssistantSelection>();

export function defaultAssistantSelection(
  owner: object,
  paseoHome: string,
): DefaultAssistantSelection {
  let selection = selections.get(owner);
  if (!selection) {
    selection = new DefaultAssistantSelection(paseoHome);
    selections.set(owner, selection);
  }
  return selection;
}

export const DEFAULT_ASSISTANT_IDENTITY =
  "You are Sunny, the user's persistent personal assistant and lead coordinator in Paseo. Your identity, ongoing decisions, and responsibilities belong to this Paseo conversation, not to the selected model provider. Switching between Codex, Claude, and other models changes the execution backend, not who you are.";

export { DEFAULT_ASSISTANT_PERSONA } from "./persona.js";

export const DEFAULT_ASSISTANT_PROMPT = `${DEFAULT_ASSISTANT_IDENTITY}
Start with the user's goal, without requiring them to choose a project or agent. Answer simple questions directly. For substantial work, inspect the available providers/profiles and tools, choose a suitable agent, and use Paseo's create_agent and messaging tools to delegate in an explicit appropriate workspace. Collect the result and report what was actually verified. Reuse suitable existing sessions instead of duplicating work. Use list_provider_sessions to discover local Codex/Claude histories across projects. Before connect_provider_session or sending work into a native session owned by another app, ask the user to stop that session in the original app/CLI and confirm it is idle; timestamps do not prove idleness. A connection preserves the native session ID and is not an independent copy. Use a returned linkedAgentId rather than importing a duplicate. When continuing prior work, search list_provider_sessions first. For already connected agents, use list_agents/get_agent_status and send_agent_prompt to delegate authorized work. Never bulk-import native session histories automatically. Your current directory is the conversation workspace selected by Paseo. It may be a user-selected project or a private scratch workspace. Check before assuming it is the user's project.
For requests to use Paseo's internal browser, use the injected Paseo browser_list_tabs/browser_new_tab and browser_* tools when available. Do not treat a Personal Browser or another app's IAB connection as the same browser. If Paseo browser tools are unavailable, explain the host Browser tools opt-in and request permission before enabling browser access; do not alter other browser integrations. Verify the returned tab and page state before claiming success.
Preserve the user's language and preferences. Keep ongoing decisions and handoff summaries concise. Do not claim that a delegation or tool action succeeded before checking its result. You cannot control ChatGPT dot or another product unless a connected tool explicitly supports it. Respect tool permissions and approval prompts; never enable bypass permissions, publish, delete data, or make purchases without the user's authorization. Do not run background work merely because this conversation was reopened.`;
/**
 * Name the daemon stores for the assistant's own agent, scratch project and scratch
 * workspace. Stored values are not localized; clients show their own translation
 * where they can identify the assistant (the `paseo.role` agent label).
 */
export const DEFAULT_ASSISTANT_DISPLAY_NAME = "Lead agent";
/** Auto-generated name written before the rename to "Lead agent". */
export const LEGACY_DEFAULT_ASSISTANT_DISPLAY_NAME = "Assistant";

const ASSISTANT_GIT_SCRATCH_DIRECTORY = ".paseo-assistant-workspaces";

function assistantHomeIdentity(paseoHome: string): string {
  return createHash("sha256").update(resolve(paseoHome)).digest("hex").slice(0, 24);
}

export function assistantWorkspaceDirectory(input: {
  paseoHome: string;
  requestKey: string;
  gitRoot: string | null;
}): string {
  const homeIdentity = assistantHomeIdentity(input.paseoHome);
  const sessionIdentity = createHash("sha256").update(input.requestKey).digest("hex").slice(0, 24);
  const root = input.gitRoot
    ? join(dirname(input.gitRoot), ASSISTANT_GIT_SCRATCH_DIRECTORY, homeIdentity)
    : join(input.paseoHome, "assistant");
  return join(root, sessionIdentity);
}

/** True when `directory` is a scratch directory created by `assistantWorkspaceDirectory`. */
export function isAssistantScratchDirectory(input: {
  paseoHome: string;
  directory: string;
}): boolean {
  const directory = resolve(input.directory);
  const parent = dirname(directory);
  if (parent === directory) return false;
  if (parent === resolve(input.paseoHome, "assistant")) return true;
  return (
    basename(parent) === assistantHomeIdentity(input.paseoHome) &&
    basename(dirname(parent)) === ASSISTANT_GIT_SCRATCH_DIRECTORY
  );
}

export function selectDefaultAssistantProvider(available: string[], preferred?: string): string {
  if (preferred) {
    if (!available.includes(preferred))
      throw new Error(`Provider '${preferred}' is not enabled or available.`);
    return preferred;
  }
  const candidates = ["codex", "claude", ...available.sort()];
  const selected = candidates.find((provider) => available.includes(provider));
  if (!selected)
    throw new Error("No agent provider is available. Connect Codex or Claude in host settings.");
  return selected;
}

/** A handoff is user-reviewed data, never a raw transcript or copied permissions. */
export function validateAssistantHandoff(
  handoff: { sourceAgentId: string; sourceUpdatedAt: string; text: string },
  source: {
    id: string;
    updatedAt: string;
    status: string;
    labels: Record<string, string>;
    archivedAt?: string | null;
    pendingPermissions: readonly unknown[];
    activeTurn?: unknown;
    backgroundWork?: { count: number };
  } | null,
  currentAgentId: string | null,
): void {
  if (!handoff.text.trim() || handoff.text.length > 12000) {
    throw new Error("Review a non-empty handoff of at most 12000 characters.");
  }
  if (
    !source ||
    source.id !== handoff.sourceAgentId ||
    source.id !== currentAgentId ||
    source.archivedAt ||
    source.labels["paseo.role"] !== "assistant"
  ) {
    throw new Error("The source assistant changed. Review the handoff again.");
  }
  if (
    source.status !== "idle" ||
    source.activeTurn ||
    source.pendingPermissions.length ||
    (source.backgroundWork?.count ?? 0) > 0
  ) {
    throw new Error("Wait until the source assistant is idle before transferring context.");
  }
  if (source.updatedAt !== handoff.sourceUpdatedAt) {
    throw new Error("The source conversation changed. Review the handoff again.");
  }
}

/** Use catalog capability descriptions, not a guessed model ID or version-number ranking. */
export function selectAdvancedAssistantModel(
  models: readonly {
    id: string;
    description?: string;
    isSelectable?: boolean;
    thinkingOptions?: readonly { id: string }[];
  }[],
): { model: string; thinkingOptionId?: string } | undefined {
  const candidates = models.filter(
    (model) =>
      model.isSelectable !== false && !/previous|older|deprecated/i.test(model.description ?? ""),
  );
  const selected =
    candidates.find((model) => /\bfrontier\b/i.test(model.description ?? "")) ??
    candidates.find((model) =>
      /most (?:capable|powerful)|most demanding/i.test(model.description ?? ""),
    );
  if (!selected) return undefined;
  return {
    model: selected.id,
    ...(selected.thinkingOptions?.some((option) => option.id === "high")
      ? { thinkingOptionId: "high" }
      : {}),
  };
}

export function configuredAssistantModel(
  value: unknown,
): { model: string; thinkingOptionId?: string } | undefined {
  const parsed = z
    .object({
      options: z
        .object({
          model: z.string().optional(),
          model_reasoning_effort: z.string().optional(),
        })
        .passthrough()
        .optional(),
      models: z
        .array(z.object({ id: z.string(), isDefault: z.boolean().optional() }).passthrough())
        .optional(),
      additionalModels: z
        .array(z.object({ id: z.string(), isDefault: z.boolean().optional() }).passthrough())
        .optional(),
    })
    .passthrough()
    .safeParse(value);
  if (!parsed.success) return undefined;
  const valueModel =
    parsed.data.options?.model ??
    [...(parsed.data.models ?? []), ...(parsed.data.additionalModels ?? [])].find(
      (model) => model.isDefault,
    )?.id;
  return valueModel
    ? {
        model: valueModel,
        thinkingOptionId: parsed.data.options?.model_reasoning_effort,
      }
    : undefined;
}

export function resolveAssistantModelSelection(input: {
  request: { provider?: string; model?: string; thinkingOptionId?: string };
  previous: {
    provider: string;
    model: string | null;
    thinkingOptionId?: string | null;
  } | null;
  provider: string;
  freshDefault: boolean;
  fallback?: { model: string; thinkingOptionId?: string };
}) {
  const { request, previous, provider, freshDefault, fallback } = input;
  const inherit =
    !freshDefault && request.provider === undefined && previous?.provider === provider;
  const previousModel = inherit ? (previous.model ?? undefined) : undefined;
  const model = request.model ?? previousModel ?? fallback?.model;
  const previousThinking =
    inherit && model === previousModel ? (previous.thinkingOptionId ?? undefined) : undefined;
  const thinkingOptionId =
    request.thinkingOptionId ??
    previousThinking ??
    (request.model === undefined ? fallback?.thinkingOptionId : undefined);
  return { model, thinkingOptionId };
}
