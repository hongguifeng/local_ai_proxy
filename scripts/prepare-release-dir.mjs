import { mkdir, rm } from "node:fs/promises";
const target = new URL("../release/npm/", import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
