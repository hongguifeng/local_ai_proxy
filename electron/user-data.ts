import path from "node:path";

export interface UserDataApp {
  getPath(name: "userData"): string;
  setPath(name: "userData", value: string): void;
}

export function configureElectronUserData(
  app: UserDataApp,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env["LLM_PROXY_DATA_DIR"]?.trim();
  const portableDirectory = env["PORTABLE_EXECUTABLE_DIR"]?.trim();
  const resolved = configured
    ? path.resolve(configured)
    : portableDirectory
      ? path.resolve(portableDirectory)
      : app.getPath("userData");
  app.setPath("userData", resolved);
  return resolved;
}
