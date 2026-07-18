import { formatStartupError } from "../src/cli/index.js";

export interface ErrorDialog {
  showErrorBox(title: string, content: string): void;
}

export function showStartupError(error: unknown, dialog: ErrorDialog): void {
  dialog.showErrorBox("LLM Proxy failed to start", formatStartupError(error));
}
