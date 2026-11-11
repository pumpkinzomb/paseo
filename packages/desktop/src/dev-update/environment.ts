/** Shell startup can set live-runtime endpoints. Preserve the supervisor's
 * isolation boundary while still importing ordinary tools and PATH settings. */
export function inheritSupervisedLoginShellEnv(input: {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  inherit: () => void;
}): void {
  const supervised =
    !input.isPackaged &&
    Boolean(input.env.PASEO_DEV_UPDATE_CONTROL_DIR && input.env.PASEO_DEV_UPDATE_GENERATION);
  if (!supervised) {
    input.inherit();
    return;
  }
  const protectedKey = (key: string) =>
    /^(PASEO_|EXPO_)/.test(key) ||
    key === "NODE_OPTIONS" ||
    key === "ELECTRON_RUN_AS_NODE" ||
    key === "APP_VARIANT" ||
    key === "BROWSER";
  const original = Object.fromEntries(
    Object.entries(input.env).filter(([key]) => protectedKey(key)),
  );
  try {
    input.inherit();
  } finally {
    for (const key of Object.keys(input.env)) {
      if (protectedKey(key)) delete input.env[key];
    }
    for (const [key, value] of Object.entries(original)) {
      if (value !== undefined) input.env[key] = value;
    }
  }
}
