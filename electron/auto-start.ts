import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LoginItemSettingsOptions {
  readonly openAtLogin: boolean;
  readonly path?: string;
}

export interface LoginItemApp {
  getAppPath(): string;
  getLoginItemSettings(options?: { readonly path?: string }): {
    readonly openAtLogin: boolean;
  };
  isPackaged: boolean;
  setLoginItemSettings(options: LoginItemSettingsOptions): void;
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
  const loginItemPath = resolveLoginItemPath(dependencies.environment);
  // The portable executable unpacks to a temporary directory that is deleted
  // when the app exits, so Electron's default path (the unpacked copy) would
  // register a Run entry that points at a file which no longer exists at
  // login. When the launcher exposes the original executable path, register
  // that stable path instead; Electron re-launches the portable exe, which
  // unpacks and runs normally. If the launcher gives us no stable path at all,
  // keep the historical behaviour of skipping the registry entirely.
  const portableWithoutPath =
    loginItemPath === undefined && Boolean(dependencies.environment["PORTABLE_EXECUTABLE_DIR"]);
  const openAtLogin = autoStart && !portableWithoutPath;
  const settings: LoginItemSettingsOptions =
    loginItemPath === undefined ? { openAtLogin } : { openAtLogin, path: loginItemPath };
  try {
    dependencies.app.setLoginItemSettings(settings);
  } catch {
    // A failed registry write leaves the previous setting in place.
  }
  return readAutoStartState(dependencies.app, autoStart, loginItemPath);
}

export function readAutoStartState(
  app: LoginItemApp,
  requested: boolean,
  loginItemPath?: string,
): AutoStartState {
  try {
    // Electron compares the stored Run entry against the queried path, so a
    // custom `path` must be passed here as well or the read reports false.
    const options = loginItemPath === undefined ? undefined : { path: loginItemPath };
    return { autoStart: app.getLoginItemSettings(options).openAtLogin };
  } catch {
    return { autoStart: requested };
  }
}

/**
 * Resolve the stable executable to register as a login item for a portable
 * build, or `undefined` for the installer build (Electron then defaults to
 * the current executable path, which is already stable).
 */
export function resolveLoginItemPath(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const file = environment["PORTABLE_EXECUTABLE_FILE"]?.trim();
  if (file) {
    return file;
  }
  const directory = environment["PORTABLE_EXECUTABLE_DIR"]?.trim();
  const filename = environment["PORTABLE_EXECUTABLE_APP_FILENAME"]?.trim();
  if (directory && filename) {
    return path.resolve(directory, filename);
  }
  return undefined;
}

function isMissingFile(value: unknown): boolean {
  return value instanceof Error && "code" in value && value.code === "ENOENT";
}
