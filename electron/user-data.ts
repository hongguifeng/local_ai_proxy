import path from "node:path";

export interface UserDataApp {
  setPath(name: "userData", value: string): void;
}

export function configureElectronUserData(
  app: UserDataApp,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = env["LLM_PROXY_USER_DATA_DIR"]?.trim();
  if (!configured) return undefined;
  const resolved = path.resolve(configured);
  app.setPath("userData", resolved);
  return resolved;
}
