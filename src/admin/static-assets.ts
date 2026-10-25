import { readFile } from "node:fs/promises";

import { SUGGESTED_STRIP_REQUEST_FIELDS } from "../config/index.js";
import type { AdminStaticAssets } from "./admin-contracts.js";

const STRIP_FIELDS_PLACEHOLDER = "__SUGGESTED_STRIP_REQUEST_FIELDS__";

/**
 * The admin UI is authored as classic-script parts that share one global scope.
 * They are concatenated in this exact order into the single /static/app.js the
 * browser loads: function declarations hoist per part, but top-level statements
 * run in load order, so the wiring part must stay last.
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

export async function loadAdminStaticAssets(): Promise<AdminStaticAssets> {
  const [indexHtml, appCss, scriptParts] = await Promise.all([
    readStaticAsset("index.html"),
    readStaticAsset("app.css"),
    Promise.all(ADMIN_SCRIPT_PARTS.map(readStaticAsset)),
  ]);
  const appJsTemplate = scriptParts.join("\n");
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

function readStaticAsset(name: string): Promise<string> {
  return readAdminStaticAsset(name);
}
