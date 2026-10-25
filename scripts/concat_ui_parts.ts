import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ADMIN_SCRIPT_PARTS, buildAdminAppJsTemplate } from "../src/admin/static-assets.js";

/**
 * The browser is served one script: the server concatenates the generated ES module
 * bundle with the numbered classic parts and replaces one placeholder. Materialising
 * that same text into a single file lets ESLint check the program the way the browser
 * sees it, cross-file references included, because ESLint gives every file its own
 * script scope and a reference from one part to a declaration in a sibling part reads
 * as no-undef.
 *
 * What is written here is byte-for-byte what `loadAdminStaticAssets()` assembles, so a
 * lint error is an error in the shipped script. Run it with `npm run lint`, which
 * bundles first; a missing chunk fails here instead of serving a page without it.
 */

const OUT_DIR = path.resolve(import.meta.dirname, "../.ui-check");
const OUT_FILE = path.join(OUT_DIR, "app.js");

const BANNER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// The admin UI script the server assembles: the bundled ES modules, then the",
  "// numbered classic parts in the order the server loads them.",
  "// It exists so ESLint sees one script scope instead of one scope per part.",
  "// Regenerate with: npx tsx scripts/concat_ui_parts.ts",
  "",
].join("\n");

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, BANNER + (await buildAdminAppJsTemplate()));
  console.log(
    `wrote ${OUT_FILE} from the module bundle and ${ADMIN_SCRIPT_PARTS.length} classic parts`,
  );
}

await main();
