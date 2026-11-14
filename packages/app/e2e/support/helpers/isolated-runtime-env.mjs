import path from "node:path";

const providerHomes = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"]);
const unsafeControl = (key) =>
  /^PASEO_(?:INSTALLED_|DEV_UPDATE_|MANAGED_|WORKTREE_|SELF_DEVELOPMENT_)/.test(key);

/** Child daemons must never inherit the calling installed app's filesystem authority. */
export function isolatedRuntimeEnv(inherited, root, overrides = {}) {
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root)
    throw new Error("An absolute test-owned runtime root is required");
  const next = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !key.startsWith("PASEO_") &&
        !providerHomes.has(key) &&
        key !== "NODE_OPTIONS" &&
        key !== "NODE_PATH",
    ),
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !unsafeControl(key) &&
      !providerHomes.has(key) &&
      key !== "NODE_OPTIONS" &&
      key !== "NODE_PATH"
    )
      next[key] = value;
  }
  for (const key of Object.keys(next)) if (unsafeControl(key)) delete next[key];
  const home = path.join(root, "user-home");
  return {
    ...next,
    PASEO_HOME: root,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    PASEO_INSTALLED_UPDATE_CONTROL: "0",
  };
}

/** Validate caller-owned roots before any fixture writes; never traverse fixture symlinks. */
export async function prepareIsolatedRuntimeEnv(inherited, root, overrides = {}) {
  const { lstat, mkdir, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const repository = await realpath(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.."),
  );
  const temporary = await realpath(tmpdir());
  const inside = (base, value) => {
    const relative = path.relative(base, value);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const env = isolatedRuntimeEnv(inherited, root, overrides);
  if (
    (!inside(repository, root) && !inside(temporary, root)) ||
    (await realpath(path.dirname(root))) !== path.dirname(root)
  )
    throw new Error(
      "Test runtime root must be canonical and inside the checkout or temporary directory",
    );
  async function ensure(directory) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Unsafe test runtime directory");
  }
  await ensure(root);
  for (const directory of new Set([
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.XDG_RUNTIME_DIR,
    env.TMPDIR,
  ])) {
    let current = root;
    for (const part of path.relative(root, directory).split(path.sep)) {
      current = path.join(current, part);
      await ensure(current);
    }
  }
  return env;
}
