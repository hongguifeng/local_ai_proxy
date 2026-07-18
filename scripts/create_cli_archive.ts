import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZipArchive } from "archiver";

export async function createCliArchive(
  root = process.cwd(),
  releaseDirectory = path.join(root, "release"),
): Promise<string> {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") throw new Error("package.json version is missing.");
  await mkdir(releaseDirectory, { recursive: true });
  const outputPath = path.join(releaseDirectory, `llm-proxy-cli-${packageJson.version}.zip`);
  const output = createWriteStream(outputPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const completed = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
  });
  archive.pipe(output);
  archive.directory(path.join(root, "dist-node/src"), "dist-node/src");
  for (const name of ["package.json", "package-lock.json", "README.md", "README.cn.md"]) {
    archive.file(path.join(root, name), { name });
  }
  await archive.finalize();
  await completed;
  return outputPath;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createCliArchive();
}
