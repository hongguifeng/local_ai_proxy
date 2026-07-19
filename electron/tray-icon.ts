import path from "node:path";

export function resolveTrayIconPath(
  packaged: boolean,
  resourcesPath: string,
  cwd = process.cwd(),
): string {
  return packaged
    ? path.join(resourcesPath, "tray-icon.png")
    : path.resolve(cwd, "resources", "tray-icon.png");
}
