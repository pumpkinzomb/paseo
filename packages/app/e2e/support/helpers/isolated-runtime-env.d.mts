export function isolatedRuntimeEnv(
  inherited: NodeJS.ProcessEnv,
  root: string,
  overrides?: Record<string, string | undefined>,
): NodeJS.ProcessEnv;
export function prepareIsolatedRuntimeEnv(
  inherited: NodeJS.ProcessEnv,
  root: string,
  overrides?: Record<string, string | undefined>,
): Promise<NodeJS.ProcessEnv>;
