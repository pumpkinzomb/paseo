import { refreshGrokToken } from "./auth-refresh.js";
import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  usedPctOf,
  unavailable,
  type UsageAccount,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
  type UsageBalance,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const GrokUsageResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      used: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      // Official CLI CentAmount defaults omitted proto3 val to zero. Amounts are cents.
      prepaidBalance: z.object({ val: ApiNumberSchema.default(0) }).nullish(),
      onDemandUsed: z.object({ val: ApiNumberSchema.default(0) }).nullish(),
      onDemandCap: z.object({ val: ApiNumberSchema.default(0) }).nullish(),
      creditUsagePercent: ApiNumberSchema.optional(),
      currentPeriod: z
        .object({
          type: ApiOptionalStringSchema,
          end: ApiOptionalStringSchema,
        })
        .nullish(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

/** Resolve a Grok CLI token from ~/.grok/auth.json (legacy or current nested shape). */
export function extractGrokTokenFromAuth(auth: unknown): string | null {
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;

  const topLevel = record["access_token"];
  if (typeof topLevel === "string" && topLevel.length > 0) {
    return topLevel;
  }

  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  const candidates = preferred.length > 0 ? preferred : entries;

  for (const [, value] of candidates) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const nestedKey = (value as Record<string, unknown>)["key"];
    if (typeof nestedKey === "string" && nestedKey.length > 0) {
      return nestedKey;
    }
  }

  return null;
}

function grokCreditBalance(response: z.infer<typeof GrokUsageResponseSchema>): UsageBalance | null {
  const limit = response.config?.monthlyLimit?.val ?? null;
  const used = response.config?.used?.val ?? response.usage?.creditUsage ?? null;
  if (limit === null && used === null) return null;
  return {
    // Only the named monthly allowance establishes a monthly credit bucket.
    id: limit === null ? "credits" : "monthly_credits",
    label: limit === null ? "Credits" : "Monthly credits",
    used,
    remaining: limit !== null && used !== null ? Math.max(0, limit - used) : null,
    limit,
    unit: "credits",
    tone: toneFromUsedPct(usedPctOf(used, limit)),
  };
}

function grokUsageWindow(response: z.infer<typeof GrokUsageResponseSchema>): UsageWindow | null {
  const percent = response.config?.creditUsagePercent;
  if (typeof percent !== "number") return null;
  const period = response.config?.currentPeriod;
  const names = {
    USAGE_PERIOD_TYPE_WEEKLY: { id: "weekly", label: "Weekly", shortLabel: "wk" },
    USAGE_PERIOD_TYPE_MONTHLY: { id: "monthly", label: "Monthly", shortLabel: "mo" },
  };
  // An absent or unfamiliar enum does not establish a monthly duration.
  const name = names[period?.type as keyof typeof names] ?? {
    id: `period:${period?.type || "unknown"}`,
    label: period?.type || "Current period",
    shortLabel: "",
  };
  return windowFromUsedPct({
    ...name,
    utilizationPct: percent,
    resetsAt: period?.end ?? null,
    tone: toneFromUsedPct(percent),
  });
}

function grokBalances(resp: z.infer<typeof GrokUsageResponseSchema>): UsageBalance[] {
  const balance = grokCreditBalance(resp);
  const balances: UsageBalance[] = balance ? [balance] : [];
  const config = resp.config;
  if (config?.prepaidBalance) {
    balances.push({
      id: "prepaid",
      label: "Prepaid balance",
      unit: "usd",
      remaining: Math.abs(config.prepaidBalance.val) / 100,
    });
  }
  if (config?.onDemandUsed || config?.onDemandCap) {
    const used = config.onDemandUsed ? Math.abs(config.onDemandUsed.val) / 100 : null;
    const limit = config.onDemandCap ? Math.abs(config.onDemandCap.val) / 100 : null;
    balances.push({
      id: "on_demand",
      label: "Pay as you go",
      unit: "usd",
      used,
      limit,
      remaining: used !== null && limit !== null ? Math.max(0, limit - used) : null,
      tone: toneFromUsedPct(usedPctOf(used, limit)),
    });
  }

  return balances;
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  refreshToken: (locator: string) => Promise<string | undefined> = refreshGrokToken,
): Promise<UsageReport> {
  const token = await readToken(input);
  if (!token) throw new Error("Grok login store no longer exists");

  // The Grok CLI's /usage uses ?format=credits; without it, unified-billing accounts
  // get a zeroed legacy monthly shape (monthlyLimit.val 0) instead of real usage.
  const request = (bearer: string) =>
    fetchApi("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        Accept: "application/json",
      },
    });

  let res = await request(token);
  // Only an expired/rejected file credential can use the official native refresh.
  // Environment keys and forbidden (403) responses must not trigger auth changes.
  if (res.status === 401 && input.store === "file") {
    const refreshed = await refreshToken(input.locator).catch(() => undefined);
    if (refreshed && refreshed !== token) res = await request(refreshed);
  }
  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Grok usage API returned ${res.status}`);

  const resp = GrokUsageResponseSchema.parse(await res.json());
  const window = grokUsageWindow(resp);
  const balances = grokBalances(resp);

  return {
    status: "available",
    planLabel: undefined,
    windows: window ? [window] : [],
    balances,
    details: window
      ? []
      : [
          {
            id: "quota_unreported",
            label: "Plan quota",
            value: "Grok did not report plan usage percentage for this account.",
          },
        ],
  };
}

async function readToken(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator];
  try {
    return (
      extractGrokTokenFromAuth(JSON.parse(await fs.readFile(input.locator, "utf8"))) ?? undefined
    );
  } catch {
    return undefined;
  }
}
export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = ["GROK_API_KEY", "GROK_TOKEN"].map((locator) => ({
    store: "env",
    locator,
  }));
  candidates.push({ store: "file", locator: join(homedir(), ".grok", "auth.json") });
  for (const input of candidates) if (await readToken(input)) return [{ key: "default", input }];
  return [];
}
