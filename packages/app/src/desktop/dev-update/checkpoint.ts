/** Canonical serialization stays in-process. Only its digest crosses the desktop bridge. */
export function canonicalCheckpoint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCheckpoint).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalCheckpoint(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function verifyCheckpoint(input: {
  capture: () => string;
  flush: () => Promise<void>;
  read: () => Promise<string>;
  revision: () => number;
  timeoutMs?: number;
}): Promise<string> {
  const revision = input.revision();
  const captured = input.capture();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await input.flush();
        const saved = await input.read();
        if (revision !== input.revision() || captured !== input.capture())
          throw new Error("checkpoint-changed");
        if (saved !== captured) throw new Error("checkpoint-not-durable");
        return captured;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("checkpoint-timeout")),
          input.timeoutMs ?? 5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
