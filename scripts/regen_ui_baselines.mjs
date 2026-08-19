import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const vitestBin = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const baselineDoc = "docs/refactoring/ui-visual-baseline.md";
const images = ["ui_proxy_cn.png", "ui_proxy_en.png", "ui_logs_cn.png", "ui_logs_en.png"];

console.log("[regen] capturing UI baselines through the visual regression tests...");
const capture = spawn(
  process.execPath,
  [vitestBin, "run", "test-node/ui/admin-ui.test.ts", "-t", "matches"],
  { stdio: "inherit", env: { ...process.env, REGEN_BASELINES: "1" } },
);
const exitCode = await new Promise((resolve) => capture.on("close", (code) => resolve(code)));
if (exitCode !== 0) {
  console.error(`[regen] baseline capture failed with exit code ${exitCode}`);
  process.exit(exitCode ?? 1);
}

let doc = await readFile(baselineDoc, "utf8");
for (const name of images) {
  const hash = createHash("sha256")
    .update(await readFile(`doc/${name}`))
    .digest("hex");
  const row = new RegExp("(\\| .*?`doc/" + name + "` \\| \\d+ x \\d+ \\| )`[0-9a-f]{64}`");
  if (!row.test(doc)) {
    console.error(`[regen] baseline row for doc/${name} not found in ${baselineDoc}`);
    process.exit(1);
  }
  doc = doc.replace(row, "$1`" + hash + "`");
  console.log(`[regen] doc/${name} -> ${hash}`);
}
await writeFile(baselineDoc, doc);
console.log(`[regen] baselines and ${baselineDoc} hashes are in sync`);
