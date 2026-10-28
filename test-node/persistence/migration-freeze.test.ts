import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { parseModuleReferences } from "../../scripts/module-edges.js";
import { responseTokenCounts } from "../../src/proxy/records.js";
import {
  frozenResponseTokenCounts,
  type FrozenResponseTokenCounts,
} from "../../src/persistence/schema-v5.js";

/**
 * [AI-13] pins the two halves of the v5 freeze: the conversion inside
 * `schema-v5.ts` must read stored response bodies exactly as the current protocol helper reads
 * them, and it must live on this side of the boundary so the protocol helper can be rewritten
 * without moving an upgrade.
 */

const FIXTURE_PATH = path.join(
  process.cwd(),
  "fixtures",
  "parity",
  "database",
  "comprehensive",
  "traffic.db",
);

interface StoredBody {
  readonly id: string;
  readonly response_body_json: string | null;
}

/** What the six stored bodies in the comprehensive fixture are worth, by record id. */
const FIXTURE_EXPECTED_COUNTS: readonly {
  readonly id: string;
  readonly expected: FrozenResponseTokenCounts;
}[] = [
  { id: "record-chat-1", expected: { request: 7, response: 5 } },
  {
    id: "record-completions-1",
    expected: { request: undefined, response: undefined },
  },
  { id: "record-messages-1", expected: { request: 13, response: 6 } },
  {
    id: "record-pending-1",
    expected: { request: undefined, response: undefined },
  },
  { id: "record-responses-1", expected: { request: 12, response: 8 } },
  {
    id: "record-responses-2",
    expected: { request: undefined, response: undefined },
  },
];

function storedResponseBodies(): StoredBody[] {
  const database = new Database(FIXTURE_PATH, { fileMustExist: true, readonly: true });
  try {
    return database
      .prepare("SELECT id, response_body_json FROM records ORDER BY id")
      .all() as StoredBody[];
  } finally {
    database.close();
  }
}

/**
 * The usage shapes `test-node/proxy/records.test.ts` pins for `responseTokenCounts` without an
 * endpoint kind. They are repeated here because the migration copy is the one that has to keep
 * reading history the same way even after the live helper is rewritten.
 */
const USAGE_SHAPES: readonly {
  readonly payload: unknown;
  readonly expected: FrozenResponseTokenCounts;
}[] = [
  {
    payload: { usage: { input_tokens: 6, output_tokens: 3 } },
    expected: { request: 6, response: 3 },
  },
  {
    payload: { usage: { prompt_tokens: 5, completion_tokens: 2 } },
    expected: { request: 5, response: 2 },
  },
  {
    payload: {
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
      },
    },
    expected: { request: 14, response: 3 },
  },
  {
    payload: { usage: { input_tokens: 0, output_tokens: 0 } },
    expected: { request: 0, response: 0 },
  },
  {
    payload: { usage: { total_tokens: 9 } },
    expected: { request: undefined, response: undefined },
  },
  {
    payload: {
      stream_summary: { usage: { input_tokens: 4, output_tokens: 2 } },
      usage: { input_tokens: 10, output_tokens: 5 },
      response: { usage: { input_tokens: 20, output_tokens: 10 } },
    },
    expected: { request: 4, response: 2 },
  },
  {
    payload: { usage: {} },
    expected: { request: undefined, response: undefined },
  },
  {
    payload: { usage: { total_tokens: "9" } },
    expected: { request: undefined, response: undefined },
  },
  {
    payload: { usage: { input_tokens: true, output_tokens: 1.5 } },
    expected: { request: undefined, response: undefined },
  },
  { payload: null, expected: { request: undefined, response: undefined } },
  { payload: "not json", expected: { request: undefined, response: undefined } },
];

describe("[AI-13] the frozen v5 token conversion", () => {
  it("agrees with the live protocol helper on every stored response body", () => {
    const storedBodies = new Map(
      storedResponseBodies().map(({ id, response_body_json }) => [id, response_body_json]),
    );
    expect([...storedBodies.keys()]).toEqual(FIXTURE_EXPECTED_COUNTS.map(({ id }) => id));

    for (const { id, expected } of FIXTURE_EXPECTED_COUNTS) {
      const stored = storedBodies.get(id);
      expect(stored === null || typeof stored === "string").toBe(true);
      const payload = typeof stored === "string" ? (JSON.parse(stored) as unknown) : null;
      const frozen = frozenResponseTokenCounts(payload);
      // The expected value is written out on its own, so a drift in the frozen copy shows up even
      // if the live helper drifts the same way; the second assertion is what proves the copy
      // matches the live no-kind path as it behaves today.
      expect(frozen).toEqual(expected);
      expect(frozen).toEqual(responseTokenCounts(payload));
    }
  });

  it.each(USAGE_SHAPES)(
    "reads the %# usage shape the live helper reads it as",
    ({ payload, expected }) => {
      expect(frozenResponseTokenCounts(payload)).toEqual(expected);
      expect(frozenResponseTokenCounts(payload)).toEqual(responseTokenCounts(payload));
    },
  );

  it("keeps the conversion on the persistence side of the boundary", async () => {
    const source = await readFile(
      new URL("../../src/persistence/schema-v5.ts", import.meta.url),
      "utf8",
    );
    const MODULE_NAME = "src/persistence/schema-v5.ts";
    const references = parseModuleReferences(source, MODULE_NAME);

    // Nothing outside this directory: the upgrade must not load code another task is rewriting.
    expect(references.map((reference) => reference.specifier)).toEqual([
      "./body-storage.js",
      "./database.js",
    ]);
    expect(references.filter((reference) => !reference.specifier.startsWith("./"))).toEqual([]);

    // The migration runs the frozen copy and never the live protocol helper. The old
    // `toContain("frozenResponseTokenCounts(payload)")` could not tell those apart:
    // `responseTokenCounts(payload)` is written in this file's own comment, so a text
    // search proved nothing about which function actually runs. Reading the call tree
    // does, and it also proves the type-only import is the only reason `./database.js`
    // appears at all.
    const called = calledNames(source, MODULE_NAME);
    expect(called).toContain("frozenResponseTokenCounts");
    expect(called).not.toContain("responseTokenCounts");
    expect(
      references.filter((reference) => !reference.typeOnly).map((reference) => reference.specifier),
    ).toEqual(["./body-storage.js"]);
  });

  /**
   * The audit of every migration's dependencies, written as an assertion so it cannot go stale.
   *
   * `./database.js` is a type-only import and loads nothing. Two migrations reach a live helper:
   * `schema-v3.ts` calls `migrateLegacyRecordBodies`, which moves the inline body columns into the
   * chunk store, and `schema-v5.ts` calls `loadRecordBody` to read those chunks back. Both stay
   * bound to `./body-storage.js` on purpose: a stored chunk records its own codec and raw size, so
   * the body text survives byte for byte whatever the chunking rules become, and neither step
   * reinterprets a stored value. Nothing here may point at `../proxy`, `../pricing` or
   * `../logging` - those hold code current features rewrite, and an upgrade must not follow them.
   * `src/persistence/pricing-store.ts` also reads `../pricing/index.js`, but it is a query-side
   * aggregation that writes nothing and belongs to no migration, so it is not on this list.
   */
  it("[AI-13] lists what every migration module imports", async () => {
    const migrationDirectory = new URL("../../src/persistence/", import.meta.url);
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => /^schema-v\d+\.ts$/.test(name))
      .sort();
    expect(migrationFiles).toHaveLength(14);

    const imports: Record<string, string[]> = {};
    for (const file of migrationFiles) {
      const source = await readFile(new URL(file, migrationDirectory), "utf8");
      // The same AST reader `npm run check:modules` uses. A regex over `from "..."`
      // misses a specifier written across several lines and counts a commented-out
      // import as a dependency; this reader sees what the runtime actually loads.
      imports[file] = parseModuleReferences(source, file).map((reference) => reference.specifier);
    }

    expect(imports).toEqual({
      "schema-v1.ts": ["./database.js"],
      "schema-v2.ts": ["./database.js"],
      "schema-v3.ts": ["./body-storage.js", "./database.js"],
      "schema-v4.ts": ["./database.js"],
      "schema-v5.ts": ["./body-storage.js", "./database.js"],
      "schema-v6.ts": ["./database.js"],
      "schema-v7.ts": ["./database.js"],
      "schema-v8.ts": ["./database.js"],
      "schema-v9.ts": ["./database.js"],
      "schema-v10.ts": ["./database.js"],
      "schema-v11.ts": ["./database.js"],
      "schema-v12.ts": ["./database.js"],
      "schema-v13.ts": ["./database.js"],
      "schema-v14.ts": ["./database.js"],
    });
  });
});

/** Names a module calls, read out of the syntax tree instead of out of its text. */
function calledNames(sourceText: string, moduleName: string): string[] {
  const sourceFile = ts.createSourceFile(
    moduleName,
    sourceText,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        names.push(callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        names.push(callee.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}
