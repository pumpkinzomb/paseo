import path from "node:path";

/** Used only on the daemon's built-in launch path, never external plugin loading. */
export function builtinHostContext(id: string, directory: string, settingsDirectory?: string, runtimeMode: "development" | "packaged" = "packaged") {
  if (id !== "external-connections" || !settingsDirectory || !path.isAbsolute(settingsDirectory) || !path.isAbsolute(directory)) return undefined;
  return Object.freeze({
    stateDirectory: path.join(settingsDirectory, "external-connections-host"),
    pluginDirectory: directory,
    runtimeMode,
  });
}
