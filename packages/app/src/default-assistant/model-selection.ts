import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface AssistantModelSelection {
  provider: string;
  model: string;
}

export interface AssistantModelGroup {
  provider: string;
  label: string;
  models: AgentModelDefinition[];
}

export type ModelPriceStatus = "paid" | "free" | "unknown";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Prices only, never numeric context-window thresholds or guesses from a model name. */
function tierPriceStatus(value: unknown): ModelPriceStatus {
  const tier = record(value);
  if (!tier) return "unknown";
  const cache = record(tier.cache);
  const rates = [
    tier.input,
    tier.output,
    cache?.read ?? tier.cache_read,
    cache?.write ?? tier.cache_write,
  ];
  if (rates.some((rate) => typeof rate === "number" && Number.isFinite(rate) && rate > 0))
    return "paid";
  if (tier.cache !== undefined && !cache) return "unknown";
  // Missing optional cache rates are harmless, but input/output must be explicit.
  if (rates[0] !== 0 || rates[1] !== 0) return "unknown";
  if (
    rates.some(
      (rate) =>
        rate !== undefined && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0),
    )
  )
    return "unknown";
  return "free";
}

export function assistantModelPriceStatus(model: AgentModelDefinition): ModelPriceStatus {
  const cost = model.metadata?.cost;
  const tiers = Array.isArray(cost) ? cost : [cost];
  if (!tiers.length) return "unknown";
  const statuses = tiers.map(tierPriceStatus);
  const legacyExtra = record(cost)?.experimentalOver200K;
  if (legacyExtra !== undefined) statuses.push(tierPriceStatus(legacyExtra));
  if (statuses.includes("paid")) return "paid";
  return statuses.every((status) => status === "free") ? "free" : "unknown";
}

export function availableAssistantModels(
  models: AgentModelDefinition[],
  provider?: string,
): AgentModelDefinition[] {
  const selectable = models.filter(
    (model) =>
      model.isSelectable !== false &&
      !(provider === "opencode" && assistantModelPriceStatus(model) === "free"),
  );
  const ordered = [
    ...selectable.filter((model) => model.isDefault),
    ...selectable.filter((model) => !model.isDefault),
  ];
  const ids = new Set<string>();
  return ordered.filter((model) => {
    if (ids.has(model.id)) return false;
    ids.add(model.id);
    return true;
  });
}

export function filterAssistantModelGroups(
  groups: AssistantModelGroup[],
  query: string,
): AssistantModelGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        `${group.label} ${group.provider} ${model.label} ${model.id}`
          .toLowerCase()
          .includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export function assistantModelGroups(entries: ProviderSnapshotEntry[]): AssistantModelGroup[] {
  return entries
    .filter(
      (entry) =>
        entry.enabled &&
        entry.status === "ready" &&
        !["mock", "mock-slow"].includes(entry.provider),
    )
    .map((entry) => ({
      provider: entry.provider,
      label: entry.label ?? entry.provider,
      models: availableAssistantModels(entry.models ?? [], entry.provider),
    }))
    .filter((entry) => entry.models.length > 0);
}

export function buildAssistantModelRoute(
  serverId: string,
  selection: AssistantModelSelection,
  requestId: string,
): string {
  return `/h/${encodeURIComponent(serverId)}/assistant?new=${encodeURIComponent(requestId)}&provider=${encodeURIComponent(selection.provider)}&model=${encodeURIComponent(selection.model)}`;
}

/** Same-provider changes keep the native session; cross-provider changes require review. */
export function assistantModelChangeKind(
  sourceProvider: string,
  targetProvider: string,
): "in-place" | "handoff" {
  return sourceProvider === targetProvider ? "in-place" : "handoff";
}
