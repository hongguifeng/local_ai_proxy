import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("src/admin/static");
const destination = path.resolve("dist-node/src/admin/static");
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true, force: true });
