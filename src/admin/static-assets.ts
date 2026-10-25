import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SUGGESTED_STRIP_REQUEST_FIELDS } from "../config/index.js";
import type { AdminStaticAssets } from "./admin-contracts.js";

const STRIP_FIELDS_PLACEHOLDER = "__SUGGESTED_STRIP_REQUEST_FIELDS__";
const WINDOWS_READ_ATTEMPTS = 8;
const WINDOWS_READ_DELAY_MS = 25;
/**
 * The bundle is published by `[System.IO.File]::Replace`, which briefly removes the
 * destination: a reader polling across that window gets `ENOENT` for a file that is being
 * replaced, measured once in about ten thousand back-to-back reads. The retry keeps the
 * error honest anyway — after the whole window a genuinely absent bundle still fails with
 * the "build it first" message.
 */
const WINDOWS_READ_RETRYABLE_ERROR_CODES = new Set(["EACCES", "EBUSY", "ENOENT", "EPERM"]);

/**
 * The marker every generated browser asset carries. Reading it back proves the asset
 * the server is about to serve is the one the bundler wrote, not a stray or truncated
 * file that happens to sit in the same directory.
 */
export const GENERATED_ASSET_MARKER = "GENERATED FILE - DO NOT EDIT";

/**
 * Where the generated script lives, relative to the directory that holds this project's
 * package.json. The same rule resolves it from source (`npm run dev`, Vitest), from the
 * compiled tree (`npm run build`) and from inside `app.asar`, because in all three the
 * package root is the directory the walk-up stops at. It deliberately sits beside
 * `src/admin/static`, never inside it: `copy_static_assets.ts` deletes anything in that
 * directory the source no longer has, and a generated script is exactly that to it.
 */
export const ADMIN_BUNDLE_DIRECTORY = ["dist-node", "src", "admin", "static-bundle"] as const;
export const ADMIN_BUNDLE_FILE = "admin-app.js";

/**
 * The script the browser runs, modulo the strip-field placeholder: the bundled module
 * graph in `src/admin/static/entry.js` and everything it imports, and nothing else.
 * `npm run lint` lints those sources directly, and the packaged-artifact test compares
 * this text with what the server actually serves.
 */
export async function buildAdminAppJsTemplate(): Promise<string> {
  return await readAdminAppScript();
}

export async function loadAdminStaticAssets(): Promise<AdminStaticAssets> {
  const [indexHtml, appCss, appJsTemplate] = await Promise.all([
    readStaticAsset("index.html"),
    readStaticAsset("app.css"),
    buildAdminAppJsTemplate(),
  ]);
  const suggestedStripFields = SUGGESTED_STRIP_REQUEST_FIELDS.join(",");
  const appJs = appJsTemplate.replaceAll(
    STRIP_FIELDS_PLACEHOLDER,
    JSON.stringify(suggestedStripFields),
  );
  if (appJs.includes(STRIP_FIELDS_PLACEHOLDER)) {
    throw new Error("Admin UI strip field placeholder was not replaced.");
  }
  return { indexHtml, appCss, appJs };
}

/** Reads one authored admin UI asset, resolved next to this module. */
export function readAdminStaticAsset(name: string): Promise<string> {
  return readFile(new URL(`./static/${name}`, import.meta.url), "utf8");
}

/**
 * Reads the generated script the browser runs. A missing or unrecognisable artifact is
 * an error here rather than an empty `<script>` in the page. The build commands complete
 * `npm run bundle:ui` before starting a reader, so an absent bundle is a clear startup
 * error instead of a polling window that can race the first build.
 */
export async function readAdminAppScript(): Promise<string> {
  const root = await findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const file = path.join(root, ...ADMIN_BUNDLE_DIRECTORY, ADMIN_BUNDLE_FILE);
  const text = await readBundleFile(file).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    const message =
      code === "ENOENT"
        ? `Admin UI script not found at ${file}. Build it first with: npm run bundle:ui`
        : `Admin UI script could not be read at ${file}: ${detail}`;
    throw new Error(message, { cause: error });
  });
  if (!text.includes(GENERATED_ASSET_MARKER)) {
    throw new Error(
      `Admin UI script at ${file} is not a generated artifact (no "${GENERATED_ASSET_MARKER}" marker).`,
    );
  }
  return text;
}

async function readBundleFile(file: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= WINDOWS_READ_ATTEMPTS - 1 ||
        !isRetryableWindowsReadError(error)
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_READ_DELAY_MS));
    }
  }
}

function isRetryableWindowsReadError(error: unknown): boolean {
  const code = errorCode(error);
  return typeof code === "string" && WINDOWS_READ_RETRYABLE_ERROR_CODES.has(code);
}

function errorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

/** The directory that holds this project's package.json, found by walking up. */
async function findPackageRoot(startDirectory: string): Promise<string> {
  let directory = startDirectory;
  for (;;) {
    const probe = path.join(directory, "package.json");
    try {
      await access(probe);
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(
          `No package.json above ${startDirectory}: cannot locate the admin UI bundle.`,
        );
      }
      directory = parent;
    }
  }
}

function readStaticAsset(name: string): Promise<string> {
  return readAdminStaticAsset(name);
}
