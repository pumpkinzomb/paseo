import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/** Distribution metadata is supplied by packaging, never by a renderer or environment flag. */
export function allowsUpstreamUpdatesFromPackage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const distribution = (metadata as Record<string, unknown>).paseoDistribution;
  // Existing upstream packages predate the explicit policy.
  if (distribution === undefined) return true;
  if (!distribution || typeof distribution !== "object" || Array.isArray(distribution))
    return false;
  const policy = distribution as Record<string, unknown>;
  return (
    policy.schemaVersion === 1 &&
    policy.channel === "upstream" &&
    policy.updatePolicy === "upstream"
  );
}

export function allowsUpstreamAppUpdates(): boolean {
  if (!app.isPackaged) return false;
  try {
    const metadata: unknown = JSON.parse(
      readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"),
    );
    return allowsUpstreamUpdatesFromPackage(metadata);
  } catch {
    // A missing or unreadable package is not permission to download another distribution.
    return false;
  }
}
