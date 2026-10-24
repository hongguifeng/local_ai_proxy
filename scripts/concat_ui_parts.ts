import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ADMIN_SCRIPT_PARTS, readAdminStaticAsset } from "../src/admin/static-assets.js";

/**
 * The admin UI is split into numbered classic scripts, but the browser still runs
 * one script: the server concatenates these files in this exact order when it
 * serves /static/app.js. ESLint gives every file its own script scope, so a
 * reference from one part to a declaration in a sibling part reads as no-undef.
 * Materialising the same concatenation into a single file lets ESLint check the
 * program the way the browser sees it, including cross-file references.
 */

const OUT_DIR = path.resolve(import.meta.dirname, "../.ui-check");
const OUT_FILE = path.join(OUT_DIR, "app.js");

const BANNER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Concatenation of the numbered admin UI scripts, in the order the server",
  "// uses when it serves /static/app.js. It exists so ESLint sees one script",
  "// scope instead of one scope per part.",
  "// Regenerate with: npx tsx scripts/concat_ui_parts.ts",
  "",
].join("\n");

async function main() {
  const parts = await Promise.all(ADMIN_SCRIPT_PARTS.map((name) => readAdminStaticAsset(name)));
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, BANNER + parts.join("\n"));
  console.log(`wrote ${OUT_FILE} from ${parts.length} parts`);
}

await main();
