import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LoginItemApp {
  getAppPath(): string;
  getLoginItemSettings(): { readonly openAtLogin: boolean };
  isPackaged: boolean;
  setLoginItemSettings(options: { openAtLogin: boolean }): void;
}

export interface AutoStartState {
  readonly autoStart: boolean;
}

export interface AutoStartDependencies {
  readonly app: LoginItemApp;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dataDirectory: string;
}

export interface AutoStartController {
  readonly state: AutoStartState;
  toggle(): Promise<void>;
}

const AUTO_START_CONFIG_PATH = "auto-start.json";
const AUTO_START_CONFIG_KEY = "autoStart";
const AUTO_START_DEFAULT = false;

export async function createAutoStartController(
  dependencies: AutoStartDependencies,
): Promise<AutoStartController> {
  const stored = await loadAutoStartState(dependencies.dataDirectory);
  let state = configureAutoStart(dependencies, stored.autoStart);
  return {
    get state() {
      return state;
    },
    async toggle() {
      const next = !state.autoStart;
      state = configureAutoStart(dependencies, next);
      await saveAutoStartState(state.autoStart, dependencies.dataDirectory);
    },
  };
}

export async function loadAutoStartState(dataDirectory: string): Promise<AutoStartState> {
  const configPath = path.join(dataDirectory, AUTO_START_CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return { autoStart: AUTO_START_DEFAULT };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { autoStart: AUTO_START_DEFAULT };
  }
  if (value === null || typeof value !== "object" || !(AUTO_START_CONFIG_KEY in value)) {
    return { autoStart: AUTO_START_DEFAULT };
  }
  return { autoStart: (value as Record<string, unknown>)[AUTO_START_CONFIG_KEY] === true };
}

export async function saveAutoStartState(
  autoStart: boolean,
  dataDirectory: string,
): Promise<AutoStartState> {
  const configPath = path.join(dataDirectory, AUTO_START_CONFIG_PATH);
  const serialized = `${JSON.stringify({ [AUTO_START_CONFIG_KEY]: autoStart }, null, 2)}\n`;
  await writeFile(configPath, serialized, "utf8");
  return { autoStart };
}

function configureAutoStart(
  dependencies: AutoStartDependencies,
  autoStart: boolean,
): AutoStartState {
  if (!dependencies.app.isPackaged) {
    return { autoStart };
  }
  // The portable executable is unpacked to a temporary directory, so its
  // resolved path cannot be used as a stable Run entry; skip the registry
  // and report that startup was not enabled.
  const openAtLogin = autoStart && !dependencies.environment["PORTABLE_EXECUTABLE_DIR"];
  try {
    dependencies.app.setLoginItemSettings({ openAtLogin });
  } catch {
    // A failed registry write leaves the previous setting in place.
  }
  return readAutoStartState(dependencies.app, autoStart);
}

export function readAutoStartState(app: LoginItemApp, requested: boolean): AutoStartState {
  try {
    return { autoStart: app.getLoginItemSettings().openAtLogin };
  } catch {
    return { autoStart: requested };
  }
}

function isMissingFile(value: unknown): boolean {
  return value instanceof Error && "code" in value && value.code === "ENOENT";
}
