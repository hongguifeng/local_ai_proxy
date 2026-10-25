import { execFile } from "node:child_process";
import { build } from "esbuild";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ADMIN_BUNDLE_DIRECTORY,
  ADMIN_BUNDLE_FILE,
  GENERATED_ASSET_MARKER,
} from "../src/admin/static-assets.js";

/**
 * The admin UI is authored as ES modules (`src/admin/static/entry.js` and the files it
 * imports) and the browser is served one file at one URL. This step bundles that module
 * graph into the single classic-script chunk the server answers /static/app.js with, so
 * every probe that intercepts that URL keeps working and the page never depends on a
 * module-capable script tag or on a second request.
 *
 * Run it with `npm run bundle:ui`. It is wired into `predev`, `pretest` and `build`
 * because every one of those paths serves the page.
 */

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const ENTRY_POINT = path.join(ROOT_DIR, "src", "admin", "static", "entry.js");
const OUTPUT_DIRECTORY = path.join(ROOT_DIR, ...ADMIN_BUNDLE_DIRECTORY);

const WINDOWS_REPLACEMENT_ATTEMPTS = 8;
const WINDOWS_REPLACEMENT_DELAY_MS = 25;
const WINDOWS_RETRYABLE_ERROR_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM", "ETXTBSY"]);

const BANNER = [
  `// ${GENERATED_ASSET_MARKER}.`,
  "// Bundled from src/admin/static/entry.js by scripts/build_ui_bundle.ts.",
  "// The server serves this chunk as /static/app.js; it is the whole admin UI.",
  "// Regenerate with: npm run bundle:ui",
  "",
].join("\n");

export async function buildAdminAppScript(
  outputFile = path.join(OUTPUT_DIRECTORY, ADMIN_BUNDLE_FILE),
): Promise<string> {
  const outputDirectory = path.dirname(outputFile);
  await mkdir(outputDirectory, { recursive: true });
  await rm(path.join(outputDirectory, "modules-bridge.js"), { force: true });
  const temporaryDirectory = await mkdtemp(path.join(outputDirectory, ".admin-app-"));
  const temporaryFile = path.join(temporaryDirectory, ADMIN_BUNDLE_FILE);
  try {
    await build({
      entryPoints: [ENTRY_POINT],
      outfile: temporaryFile,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      charset: "utf8",
      legalComments: "none",
      banner: { js: BANNER },
    });
    await replaceOutputFile(temporaryFile, outputFile);
    return outputFile;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function replaceOutputFile(temporaryFile: string, outputFile: string): Promise<void> {
  if (process.platform !== "win32") {
    await rename(temporaryFile, outputFile);
    return;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < WINDOWS_REPLACEMENT_ATTEMPTS; attempt += 1) {
    try {
      // This is also the clean-start path. rename is atomic and works when the
      // destination does not exist yet.
      await rename(temporaryFile, outputFile);
      return;
    } catch (error) {
      if (!isRetryableWindowsError(error)) {
        throw error;
      }
    }

    try {
      // Node's Windows rename cannot replace an existing file; File.Replace is
      // atomic and keeps readers away from a partially written destination.
      await replaceOutputFileOnWindows(temporaryFile, outputFile);
      return;
    } catch (error) {
      if (!isRetryableWindowsReplacementError(error)) {
        throw error;
      }
      lastError = error;
    }

    if (attempt + 1 < WINDOWS_REPLACEMENT_ATTEMPTS) {
      await delay(WINDOWS_REPLACEMENT_DELAY_MS * (attempt + 1));
    }
  }

  throw new Error(
    `Could not publish the admin UI bundle after ${WINDOWS_REPLACEMENT_ATTEMPTS} ` +
      `Windows replacement attempts: ${outputFile}`,
    { cause: lastError },
  );
}

function isRetryableWindowsError(error: unknown): boolean {
  const code = errorCode(error);
  return typeof code === "string" && WINDOWS_RETRYABLE_ERROR_CODES.has(code);
}

function isRetryableWindowsReplacementError(error: unknown): boolean {
  const code = errorCode(error);
  // execFile reports a PowerShell non-zero exit as a numeric code. Its underlying
  // IOException is a transient sharing/access failure in the replacement path; a
  // missing executable or other named filesystem error is a real setup failure.
  return typeof code === "number" || code === undefined || WINDOWS_RETRYABLE_ERROR_CODES.has(code);
}

function errorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Node's Windows rename cannot replace an existing file; File.Replace is atomic. */
async function replaceOutputFileOnWindows(
  temporaryFile: string,
  outputFile: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.IO.File]::Replace($env:LLM_PROXY_ADMIN_APP_TEMP, $env:LLM_PROXY_ADMIN_APP_OUTPUT, $env:LLM_PROXY_ADMIN_APP_BACKUP)",
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          LLM_PROXY_ADMIN_APP_TEMP: temporaryFile,
          LLM_PROXY_ADMIN_APP_OUTPUT: outputFile,
          LLM_PROXY_ADMIN_APP_BACKUP: `${temporaryFile}.backup`,
        },
      },
      (error) => {
        if (error !== null) {
          reject(error instanceof Error ? error : new Error("Windows file replacement failed"));
          return;
        }
        resolve();
      },
    );
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = await buildAdminAppScript();
  console.log(`wrote ${written} from ${ENTRY_POINT}`);
}
