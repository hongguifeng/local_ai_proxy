import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}

export async function generateChecksums(directory = path.resolve("release")): Promise<string> {
  const names = (await readdir(directory))
    .filter((name) => /\.(exe|zip)$/iu.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) throw new Error(`No release artifacts found in ${directory}.`);
  const lines = await Promise.all(
    names.map(async (name) => `${await sha256(path.join(directory, name))}  ${name}`),
  );
  const output = `${lines.join("\n")}\n`;
  await writeFile(path.join(directory, "SHA256SUMS.txt"), output, "utf8");
  return output;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateChecksums();
}
