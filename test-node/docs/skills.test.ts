import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const skillsRoot = path.join(repositoryRoot, ".agents", "skills");

// Pi advertises a skill by name and description only, and silently skips a
// SKILL.md it cannot parse, so the roster is pinned here: deleting or renaming a
// skill directory has to be a deliberate edit of this list.
const expectedSkills = [
  "admin-api-probing",
  "ci-triage",
  "css-cascade-audit",
  "design-doc-readability",
  "live-ui-probing",
  "packaging-smoke",
  "proxy-runtime",
  "real-upstream-acceptance",
  "render-internals",
  "safe-deletion",
  "static-checks-and-split",
  "statistics-charts",
  "traffic-log-forensics",
  "ui-baseline-regen",
  "ui-markup-contracts",
  "ui-test-quirks",
] as const;

// These prefixes are build output or scratch space, so a recipe may name them
// without the file existing yet (CI runs the tests before the build).
const uncheckedPrefixes = [
  "dist-node/",
  "dist-electron/",
  "release/",
  "node_modules/",
  "coverage/",
  "test-results/",
  ".ui-check/",
];

interface SkillDocument {
  directory: string;
  file: string;
  attributes: Record<string, string>;
  body: string;
}

function parseFrontmatter(text: string): { attributes: Record<string, string>; body: string } | undefined {
  if (!text.startsWith("---\n")) {
    return undefined;
  }
  const closing = text.indexOf("\n---\n", "---\n".length);
  if (closing < 0) {
    return undefined;
  }
  const lines = text.slice("---\n".length, closing).split("\n");
  const attributes: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(lines[index] ?? "");
    const key = entry?.[1];
    let value = entry?.[2] ?? "";
    if (key === undefined) {
      continue;
    }
    // A block scalar keeps its text on the following indented lines, so the
    // length Pi measures is only visible after those lines are joined back in.
    if (/^[|>][-+]?\d*$/.test(value)) {
      const collected: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        if (!/^\s+\S/.test(next)) {
          break;
        }
        collected.push(next.trim());
        index += 1;
      }
      value = collected.join(" ");
    }
    attributes[key] = value.replace(/^["']|["']$/g, "");
  }
  return { attributes, body: text.slice(closing + "\n---\n".length) };
}

async function loadSkills(): Promise<SkillDocument[]> {
  const documents: SkillDocument[] = [];
  for (const directory of (await readdir(skillsRoot)).sort()) {
    const file = path.join(skillsRoot, directory, "SKILL.md");
    const text = await readFile(file, "utf8");
    const parsed = parseFrontmatter(text);
    documents.push({
      directory,
      file,
      attributes: parsed?.attributes ?? {},
      body: parsed?.body ?? "",
    });
  }
  return documents;
}

function isUncheckedPath(reference: string): boolean {
  return uncheckedPrefixes.some((prefix) => reference.startsWith(prefix));
}

function repoPathReferences(body: string): string[] {
  const references: string[] = [];
  // A leading "@" is a package name (@electron/asar), and a leading "/" means
  // this is the tail of a longer path (dist-node/src/main.js), not a repo path.
  for (const match of body.matchAll(/(?<![@\w./-])(?:src|test-node|docs|scripts|electron|examples)\/[\w./-]+/g)) {
    const next = body[match.index + match[0].length];
    if (next === "*" || next === "{" || next === "<" || next === "[") {
      continue;
    }
    const reference = match[0].replace(/[.,;:)"]+$/, "");
    if (!isUncheckedPath(reference)) {
      references.push(reference);
    }
  }
  return [...new Set(references)].sort();
}

describe("project skills", () => {
  it("keeps exactly the roster of skill directories Pi is meant to advertise", async () => {
    const directories = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([...expectedSkills].sort());
  });

  it("gives every skill frontmatter Pi can load", async () => {
    const documents = await loadSkills();
    const problems: string[] = [];
    for (const document of documents) {
      const name = document.attributes["name"];
      const description = document.attributes["description"];
      if (name === undefined) {
        problems.push(`${document.directory}: no name`);
        continue;
      }
      if (name !== document.directory) {
        problems.push(`${document.directory}: name "${name}" is not the directory name`);
      }
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        problems.push(`${document.directory}: name "${name}" is not lowercase-hyphen`);
      }
      if (name.length > 64) {
        problems.push(`${document.directory}: name is ${name.length} characters, over 64`);
      }
      if (description === undefined || description.length === 0) {
        problems.push(`${document.directory}: no description, Pi would not load it`);
      } else if (description.startsWith(">") || description.startsWith("|")) {
        problems.push(`${document.directory}: block scalar was not unfolded, length ${description.length}`);
      } else if (description.length > 1024) {
        problems.push(`${document.directory}: description is ${description.length} characters, over 1024`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the routing index in AGENTS.md in step with the skills on disk", async () => {
    const text = await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8");
    const indexed = [...text.matchAll(/^- `([a-z0-9]+(?:-[a-z0-9]+)*)` - /gm)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    expect([...new Set(indexed)].sort()).toEqual([...expectedSkills].sort());
  });

  it("names only commands and files that still exist", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const documents = await loadSkills();
    const problems: string[] = [];

    for (const document of documents) {
      for (const reference of repoPathReferences(document.body)) {
        if ((await stat(path.join(repositoryRoot, reference)).catch(() => undefined)) === undefined) {
          problems.push(`${document.directory}: ${reference} does not exist`);
        }
      }

      for (const match of document.body.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        const script = match[1];
        if (script !== undefined && packageJson.scripts?.[script] === undefined) {
          problems.push(`${document.directory}: npm run ${script} is not in package.json`);
        }
      }

      for (const match of document.body.matchAll(/vitest run ([^\s`]+)/g)) {
        const target = match[1];
        if (target === undefined || target.includes("<")) {
          continue;
        }
        try {
          await stat(path.join(repositoryRoot, target));
        } catch {
          problems.push(`${document.directory}: vitest target ${target} does not exist`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
