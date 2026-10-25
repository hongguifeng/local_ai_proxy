import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BRIDGE_DIRECTORY,
  BRIDGE_FILE,
  GENERATED_ASSET_MARKER,
} from "../src/admin/static-assets.js";

/**
 * The admin UI is authored as ES modules (`src/admin/static/entry.js` and the files it
 * imports) and as classic scripts at the same time: the nine numbered parts still share
 * one script scope, and the browser is served one file at one URL. This step turns the
 * module side into a single classic-script chunk that the server concatenates ahead of
 * those parts, so /static/app.js stays the only browser request and every probe that
 * intercepts that URL keeps working.
 *
 * Run it with `npm run bundle:ui`. It is wired into `predev`, `pretest` and `build`
 * because every one of those paths serves the page, and `scripts/concat_ui_parts.ts`
 * reads its output so ESLint sees the same bytes the browser does.
 */

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const ENTRY_POINT = path.join(ROOT_DIR, "src", "admin", "static", "entry.js");
const OUTPUT_DIRECTORY = path.join(ROOT_DIR, ...BRIDGE_DIRECTORY);

const BANNER = [
  `// ${GENERATED_ASSET_MARKER}.`,
  "// Bundled from src/admin/static/entry.js by scripts/build_ui_bundle.ts.",
  "// The server concatenates this chunk ahead of the numbered admin UI scripts and",
  "// serves the result as /static/app.js, so ESLint must see it too.",
  "// Regenerate with: npm run bundle:ui",
  "",
].join("\n");

export async function buildAdminModuleBridge(): Promise<string> {
  const outputFile = path.join(OUTPUT_DIRECTORY, BRIDGE_FILE);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await build({
    entryPoints: [ENTRY_POINT],
    outfile: outputFile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    charset: "utf8",
    legalComments: "none",
    banner: { js: BANNER },
  });
  return outputFile;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = await buildAdminModuleBridge();
  console.log(`wrote ${written} from ${ENTRY_POINT}`);
}
