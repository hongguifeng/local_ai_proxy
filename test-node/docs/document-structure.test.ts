import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const docsRoot = path.join(repositoryRoot, "docs");
const categories = [
  "current",
  "decisions",
  "design",
  "plans",
  "operations",
  "reports",
  "history",
] as const;

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(file)));
    } else if (entry.name.endsWith(".md")) {
      files.push(file);
    }
  }
  return files;
}

function localLinks(markdown: string): string[] {
  // Links inside inline code are examples of syntax, not document references.
  const body = markdown.replace(/`[^`]*`/g, "");
  return [...body.matchAll(/\]\(([^)\s]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1]?.split("#")[0] ?? "")
    .filter((target) => target !== "" && !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target));
}

describe("documentation structure", () => {
  it("keeps the documented categories and removes loose root documents", async () => {
    const entries = await readdir(docsRoot, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name)).toEqual([
      "README.md",
    ]);
    expect(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...categories].sort());
  });

  it("marks every current, design and plan document with a lifecycle status", async () => {
    const files = [
      ...(await markdownFiles(path.join(docsRoot, "current"))),
      ...(await markdownFiles(path.join(docsRoot, "design"))),
      ...(await markdownFiles(path.join(docsRoot, "plans"))),
      ...(await markdownFiles(path.join(docsRoot, "operations"))),
    ];
    const missing = [] as string[];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (!/^> 状态：/m.test(text) || !/^> 权威性：/m.test(text) || !/^> 更新条件：/m.test(text)) {
        missing.push(path.relative(repositoryRoot, file));
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves every local Markdown link from the file that owns it", async () => {
    const files = await markdownFiles(docsRoot);
    const missing: string[] = [];
    for (const file of files) {
      for (const target of localLinks(await readFile(file, "utf8"))) {
        if ((await stat(path.resolve(path.dirname(file), target)).catch(() => undefined)) === undefined) {
          missing.push(`${path.relative(repositoryRoot, file)}: ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps obsolete top-level document paths out of current instructions", async () => {
    const files = [
      path.join(repositoryRoot, "AGENTS.md"),
      ...(await markdownFiles(path.join(repositoryRoot, ".agents", "skills"))),
      ...(await markdownFiles(path.join(docsRoot, "current"))),
      ...(await markdownFiles(path.join(docsRoot, "design", "active"))),
      ...(await markdownFiles(path.join(docsRoot, "plans", "active"))),
    ];
    const oldPaths = [
      "docs/current-architecture.md",
      "docs/module-design.md",
      "docs/software-functional-specification.md",
      "docs/refactoring/",
      "docs/adr/",
    ];
    const problems: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const oldPath of oldPaths) {
        if (text.includes(oldPath)) problems.push(`${path.relative(repositoryRoot, file)}: ${oldPath}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
