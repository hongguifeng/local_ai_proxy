import { pathToFileURL } from "node:url";

import { main } from "./main.js";

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main();
}
