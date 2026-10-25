import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const docsRoot = path.join(repositoryRoot, "docs");

const entryFile = path.join(docsRoot, "current-architecture.md");
const historyFile = path.join(docsRoot, "module-design.md");

// [AI-04] The architecture entry is the single place to learn how the current
// application runs, so it has to cover the topics a change needs to be placed
// correctly. The module design document keeps the Python baseline and the migration
// record, and is only useful if it points back at the current entry. These checks are
// structural: they do not test the wording of any sentence.
const requiredSections = [
  "运行模型",
  "启动路径",
  "配置归属",
  "关闭顺序",
  "模块地图",
  "依赖方向",
  "验证入口",
  "材料身份",
];

async function readDocument(file: string): Promise<string> {
  return await readFile(file, "utf8");
}

function topLevelHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

function relativeLinks(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (target === undefined) {
      continue;
    }
    if (target.startsWith("#") || /^[a-z]+:\/\//.test(target)) {
      continue;
    }
    found.push(target.split("#")[0] ?? target);
  }
  return found;
}

async function findMissingLinks(markdown: string): Promise<string[]> {
  const missing: string[] = [];
  for (const target of relativeLinks(markdown)) {
    try {
      await stat(path.resolve(docsRoot, target));
    } catch {
      missing.push(target);
    }
  }
  return missing;
}

describe("current architecture entry", () => {
  it("[AI-04] covers the topics needed to place a change", async () => {
    const headings = topLevelHeadings(await readDocument(entryFile));

    for (const required of requiredSections) {
      expect(headings.filter((heading) => heading.includes(required)).length, required).toBeGreaterThan(
        0,
      );
    }
  });

  it("[AI-04] points at files that exist", async () => {
    expect(await findMissingLinks(await readDocument(entryFile))).toEqual([]);
  });
});

describe("history documents", () => {
  it("[AI-04] the module design points back at the current architecture entry", async () => {
    const document = await readDocument(historyFile);

    expect(document).toContain("./current-architecture.md");
    expect(await findMissingLinks(document)).toEqual([]);
  });
});
