import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../src/storage/migrations/", import.meta.url);
const destination = new URL("../dist/storage/migrations/", import.meta.url);

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await cp(new URL("../../web/dist/", import.meta.url), new URL("../dist/public/", import.meta.url), { recursive: true });
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = (process.env.LLM_PROXY_RELEASE_VERSION ?? packageJson.version).replace(/^v/u, "");
await writeFile(
  new URL("../dist/build-metadata.json", import.meta.url),
  `${JSON.stringify({ version, commit: process.env.LLM_PROXY_COMMIT ?? "development", buildTime: process.env.LLM_PROXY_BUILD_TIME ?? new Date().toISOString() }, null, 2)}\n`,
);
