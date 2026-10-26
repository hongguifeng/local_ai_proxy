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

// Pi loads the whole file once it decides a skill applies, so every skill answers the
// same five questions in the same order: when it applies, what must stay true while it
// runs, how to run it, how to read the result, and where the long version lives. The
// headings are the contract; the wording under them is content and is reviewed.
const requiredSections = [
  "## When this applies",
  "## Invariants",
  "## Standard commands",
  "## Reading the result",
  "## Deeper material",
] as const;

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

function markdownLinkTargets(body: string): string[] {
  const targets: string[] = [];
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (target === undefined) continue;
    // A URL, a bare anchor, or an absolute path is not a file this repository owns.
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
    targets.push(target.split("#")[0] ?? "");
  }
  return targets.filter((target) => target !== "");
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

/**
 * Repository paths and `npm run` script names a document names that no longer exist.
 *
 * Both AGENTS.md and every SKILL.md go through this, because a stale path in either one
 * reads as current instructions: the failure mode is an agent following a file that was
 * renamed two refactors ago.
 */
async function unresolvedReferences(
  label: string,
  body: string,
  scripts: Record<string, string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const reference of repoPathReferences(body)) {
    if ((await stat(path.join(repositoryRoot, reference)).catch(() => undefined)) === undefined) {
      problems.push(`${label}: ${reference} does not exist`);
    }
  }
  for (const match of body.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    const script = match[1];
    if (script !== undefined && scripts[script] === undefined) {
      problems.push(`${label}: npm run ${script} is not in package.json`);
    }
  }
  return problems;
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
      } else if (!description.includes("Use when")) {
        problems.push(`${document.directory}: description does not say when to use it`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("answers when, what must hold, how to run it, how to read it and where to go deeper", async () => {
    const documents = await loadSkills();
    const problems: string[] = [];
    for (const document of documents) {
      const headings = document.body
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.trim());
      const positions: number[] = [];
      for (const heading of requiredSections) {
        const occurrences = headings.filter((candidate) => candidate === heading).length;
        if (occurrences !== 1) {
          problems.push(`${document.directory}: expects exactly one "${heading}", found ${occurrences}`);
        }
        positions.push(headings.indexOf(heading));
      }
      const present = positions.filter((position) => position >= 0);
      const sorted = [...present].sort((left, right) => left - right);
      if (present.join(",") !== sorted.join(",")) {
        problems.push(`${document.directory}: the required sections are out of order`);
      }
      const deeper = document.body.slice(document.body.indexOf("## Deeper material"));
      if (markdownLinkTargets(deeper).length === 0) {
        problems.push(`${document.directory}: "## Deeper material" links nothing`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("resolves every local link relative to the skill that carries it", async () => {
    const documents = await loadSkills();
    const problems: string[] = [];
    for (const document of documents) {
      for (const target of markdownLinkTargets(document.body)) {
        const resolved = path.resolve(path.dirname(document.file), target);
        if (!resolved.startsWith(repositoryRoot)) {
          problems.push(`${document.directory}: ${target} points outside the repository`);
          continue;
        }
        if ((await stat(resolved).catch(() => undefined)) === undefined) {
          problems.push(`${document.directory}: ${target} does not exist`);
        }
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
      problems.push(
        ...(await unresolvedReferences(
          document.directory,
          document.body,
          packageJson.scripts ?? {},
        )),
      );

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

  // AGENTS.md is always in context while a skill is loaded on demand, so a path that
  // rots there is the one nobody re-reads: `src/proxy/protocol/analysis.js` outlived the
  // rename to `.ts` until an audit found it by hand. The same scan now covers it, so a
  // stale path or script name fails here instead of waiting for the next reader.
  it("[AI-26] names only commands and files that still exist in AGENTS.md", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const body = await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8");

    expect(await unresolvedReferences("AGENTS.md", body, packageJson.scripts ?? {})).toEqual([]);
  });
});
