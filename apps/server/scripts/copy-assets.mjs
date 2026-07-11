import { cp, mkdir } from "node:fs/promises";

const source = new URL("../src/storage/migrations/", import.meta.url);
const destination = new URL("../dist/storage/migrations/", import.meta.url);

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await cp(new URL("../../web/dist/", import.meta.url), new URL("../dist/public/", import.meta.url), { recursive: true });
