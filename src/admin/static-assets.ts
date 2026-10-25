import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SUGGESTED_STRIP_REQUEST_FIELDS } from "../config/index.js";
import type { AdminStaticAssets } from "./admin-contracts.js";

const STRIP_FIELDS_PLACEHOLDER = "__SUGGESTED_STRIP_REQUEST_FIELDS__";

/**
 * The marker every generated browser chunk carries. Reading it back proves the asset
 * the server is about to serve is the one the bundler wrote, not a stray or truncated
 * file that happens to sit in the same directory.
 */
export const GENERATED_ASSET_MARKER = "GENERATED FILE - DO NOT EDIT";

/**
 * Where the generated chunk lives, relative to the directory that holds this project's
 * package.json. The same rule resolves it from source (`npm run dev`, Vitest), from the
 * compiled tree (`npm run build`) and from inside `app.asar`, because in all three the
 * package root is the directory the walk-up stops at. It deliberately sits beside
 * `src/admin/static`, never inside it: `copy_static_assets.ts` deletes anything in that
 * directory the source no longer has, and a generated chunk is exactly that to it.
 */
export const BRIDGE_DIRECTORY = ["dist-node", "src", "admin", "static-bundle"] as const;
export const BRIDGE_FILE = "modules-bridge.js";

/**
 * The admin UI is authored as classic-script parts that share one global scope. They
 * are concatenated in this exact order into the single /static/app.js the browser
 * loads: function declarations hoist per part, but top-level statements run in load
 * order, so the wiring part must stay last.
 *
 * The generated ES module bundle is concatenated ahead of all of them, so the bridge it
 * publishes exists before the first top-level statement in `09-wiring.js` runs. See
 * `scripts/build_ui_bundle.ts` and `src/admin/static/entry.js`.
 */
export const ADMIN_SCRIPT_PARTS = [
  "01-core.js",
  "02-proxy-config.js",
  "03-load-balancing.js",
  "04-history-logs.js",
  "05-task-detail.js",
  "06-json-pane.js",
  "07-statistics.js",
  "08-metrics.js",
  "09-wiring.js",
] as const;

/**
 * The script the browser runs, modulo the strip-field placeholder: the generated module
 * bridge first, then the numbered parts in load order. `npm run lint` writes exactly
 * this text to `.ui-check/app.js`, so ESLint checks the program the browser sees.
 */
export async function buildAdminAppJsTemplate(): Promise<string> {
  const [bridge, scriptParts] = await Promise.all([
    readAdminModuleBridge(),
    Promise.all(ADMIN_SCRIPT_PARTS.map(readStaticAsset)),
  ]);
  return [bridge, ...scriptParts].join("\n");
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
 * Reads the generated classic-script chunk the ES modules are delivered in. A missing
 * or unrecognisable artifact is an error here rather than an empty `<script>` in the
 * page, so a build that skipped `npm run bundle:ui` says so instead of rendering a
 * blank console.
 */
export async function readAdminModuleBridge(): Promise<string> {
  const root = await findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const file = path.join(root, ...BRIDGE_DIRECTORY, BRIDGE_FILE);
  const text = await readBridgeFile(file).catch(() => {
    throw new Error(
      `Admin UI module bridge not found at ${file}. Build it first with: npm run bundle:ui`,
    );
  });
  if (!text.includes(GENERATED_ASSET_MARKER)) {
    throw new Error(
      `Admin UI module bridge at ${file} is not a generated artifact (no "${GENERATED_ASSET_MARKER}" marker).`,
    );
  }
  return text;
}

async function readBridgeFile(file: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 20 ||
        !(error instanceof Error && "code" in error) ||
        !["ENOENT", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
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
          `No package.json above ${startDirectory}: cannot locate the admin UI module bridge.`,
        );
      }
      directory = parent;
    }
  }
}

function readStaticAsset(name: string): Promise<string> {
  return readAdminStaticAsset(name);
}
