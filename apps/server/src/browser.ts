import { spawn } from "node:child_process";

export function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return Promise.reject(new TypeError("Invalid browser URL"));
  const command = browserCommand(url);
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

function browserCommand(url: string): { executable: string; args: string[] } {
  if (process.platform === "win32") return { executable: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  if (process.platform === "darwin") return { executable: "open", args: [url] };
  return { executable: "xdg-open", args: [url] };
}
