import { spawn } from "node:child_process";

export type BrowserLauncher = (url: string) => void;

export function openBrowserLater(
  url: string,
  delayMs = 500,
  launch: BrowserLauncher = launchBrowser,
): NodeJS.Timeout {
  const timer = setTimeout(() => launch(url), delayMs);
  timer.unref();
  return timer;
}

export function launchBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function browserCommand(url: string): {
  readonly args: readonly string[];
  readonly command: string;
} {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  }
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}
