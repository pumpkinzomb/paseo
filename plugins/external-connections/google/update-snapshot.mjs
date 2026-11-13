/** In-memory observations only; absence of downstream evidence never means idle. */
export function downstreamBlockers(service, label) {
  if (!service) return [];
  if (typeof service.getUpdateBlockers !== "function") return [`${label}: unknown`];
  try {
    const result = service.getUpdateBlockers();
    if (!Array.isArray(result) || result.some((item) => typeof item !== "string"))
      return [`${label}: unknown`];
    return result;
  } catch {
    return [`${label}: unknown`];
  }
}
export function observeService(service, snapshot) {
  const pending = new Map();
  const result = { ...service };
  for (const [name, fn] of Object.entries(service)) {
    if (typeof fn !== "function") continue;
    result[name] = (...args) => {
      pending.set(name, (pending.get(name) ?? 0) + 1);
      const finish = () => pending.set(name, pending.get(name) - 1);
      try {
        const value = fn(...args);
        if (value && typeof value.then === "function")
          return Promise.resolve(value).finally(finish);
        finish();
        return value;
      } catch (error) {
        finish();
        throw error;
      }
    };
  }
  result.getUpdateBlockers = () => [
    ...[...pending]
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `google ${name}: ${count} active`),
    ...snapshot(),
  ];
  return result;
}
