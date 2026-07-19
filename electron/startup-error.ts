import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatStartupError } from "../src/cli/index.js";

export interface ErrorDialog {
  showErrorBox(title: string, content: string): void;
}

export function showStartupError(
  error: unknown,
  dialog: ErrorDialog,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const message = formatStartupError(error);
  const errorFile = env["LLM_PROXY_STARTUP_ERROR_FILE"]?.trim();
  if (errorFile) {
    const resolved = path.resolve(errorFile);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${message}\n`, "utf8");
  }
  dialog.showErrorBox("LLM Proxy failed to start", message);
}
