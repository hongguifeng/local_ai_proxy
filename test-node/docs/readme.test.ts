import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (name: string) => readFile(path.resolve(root, name), "utf8");
const READMES = ["README.md", "README.cn.md"];

describe("README runtime instructions", () => {
  it("documents the Node quick start in both languages", async () => {
    for (const name of READMES) {
      const readme = await read(name);
      expect(readme).toContain("Node.js 24");
      expect(readme).toContain("npm ci");
      expect(readme).toContain("npm run build");
      expect(readme).toContain("npm start");
      expect(readme).toContain("127.0.0.1:18080");
      expect(readme).not.toContain("python -m llm_proxy");
    }
  });

  it("only documents `npm run` scripts that exist in package.json", async () => {
    const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    for (const name of READMES) {
      const readme = await read(name);
      for (const match of readme.matchAll(/npm run ([\w:-]+)/g)) {
        expect(scripts, `${name} documents npm run ${match[1]}`).toContain(match[1]);
      }
    }
  });

  it("links only to files that exist in the repository", async () => {
    for (const name of READMES) {
      const readme = await read(name);
      for (const match of readme.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1]?.trim();
        if (!target) continue;
        if (/^[\w+.-]+:/.test(target) || target.startsWith("/")) {
          continue; // external or absolute URL, not a repo file
        }
        expect(existsSync(path.resolve(root, target)), `link ${target} in ${name}`).toBe(true);
      }
    }
  });

  it("references the UI baseline screenshots that ship in doc/", async () => {
    for (const name of READMES) {
      const readme = await read(name);
      expect(readme).toContain("doc/ui_proxy_");
      expect(readme).toContain("doc/ui_logs_");
    }
    for (const file of [
      "doc/ui_proxy_en.png",
      "doc/ui_proxy_cn.png",
      "doc/ui_logs_en.png",
      "doc/ui_logs_cn.png",
    ]) {
      expect(existsSync(path.resolve(root, file)), file).toBe(true);
    }
  });

  it("documents where the app stores its data", async () => {
    for (const name of READMES) {
      const readme = await read(name);
      expect(readme).toContain("logs/proxies.json");
      expect(readme).toContain("llm-proxy.json");
      expect(readme).toContain("traffic.db");
    }
  });

  it("keeps the English README free of Chinese text", async () => {
    const readme = await read("README.md");
    const body = readme
      .split("\n")
      .filter((line) => !line.includes("README.cn.md"))
      .join("\n");
    expect(body).not.toMatch(/[\u4e00-\u9fff]/u);
  });
});
