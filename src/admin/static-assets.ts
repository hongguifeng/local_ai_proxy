import { readFile } from "node:fs/promises";

import { SUGGESTED_STRIP_REQUEST_FIELDS } from "../config/index.js";
import type { AdminStaticAssets } from "./admin-server.js";

const STRIP_FIELDS_PLACEHOLDER = "__SUGGESTED_STRIP_REQUEST_FIELDS__";

export async function loadAdminStaticAssets(): Promise<AdminStaticAssets> {
  const [indexHtml, appCss, appJsTemplate] = await Promise.all([
    readStaticAsset("index.html"),
    readStaticAsset("app.css"),
    readStaticAsset("app.js"),
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

function readStaticAsset(name: string): Promise<string> {
  return readFile(new URL(`./static/${name}`, import.meta.url), "utf8");
}
