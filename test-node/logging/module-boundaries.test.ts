import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildGraphFromSources,
  buildProjectGraph,
  checkModuleBoundaries,
  findRuntimeChain,
  findRuntimeCycles,
  formatChain,
  parseModuleReferences,
  resolveModuleReference,
  runtimeClosure,
  TRANSPORT_ROOT_MODULES,
} from "../../scripts/module-edges.js";
import { taskIdentity } from "../../src/proxy/protocol/task-identity.js";

/**
 * [AI-10] proves the module checker is not decorative. Every case here feeds the
 * checker sources it must reject, and the expected report is the concrete
 * dependency chain, not just a boolean.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function graphOf(sources: Record<string, string>): ReturnType<typeof buildGraphFromSources> {
  return buildGraphFromSources(new Map(Object.entries(sources)));
}

function violationsOf(sources: Record<string, string>): ReturnType<typeof checkModuleBoundaries> {
  return checkModuleBoundaries(graphOf(sources));
}

describe("[AI-10] specifier resolution", () => {
  it("maps a .js specifier onto the .ts source and onto a directory barrel", () => {
    const sources = {
      "src/proxy/index.ts": 'export { helper } from "./analysis.js";\n',
      "src/proxy/analysis.ts": "export function helper(): number { return 1; }\n",
      "src/app/runtime.ts": 'import { helper } from "../proxy/index.js";\n',
      "src/proxy/barrel/index.ts": "export const value = 1;\n",
      "src/config/store.ts": 'import { value } from "../proxy/barrel";\n',
    };
    const knownModules = new Set(Object.keys(sources));

    expect(resolveModuleReference("src/proxy/index.ts", "./analysis.js", knownModules)).toBe(
      "src/proxy/analysis.ts",
    );
    expect(resolveModuleReference("src/app/runtime.ts", "../proxy/index.js", knownModules)).toBe(
      "src/proxy/index.ts",
    );
    expect(resolveModuleReference("src/config/store.ts", "../proxy/barrel", knownModules)).toBe(
      "src/proxy/barrel/index.ts",
    );

    const graph = graphOf(sources);
    expect(graph.runtimeEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([
      "src/app/runtime.ts -> src/proxy/index.ts",
      "src/config/store.ts -> src/proxy/barrel/index.ts",
      "src/proxy/index.ts -> src/proxy/analysis.ts",
    ]);
  });

  it("keeps pure type imports out of the runtime graph but keeps value re-exports in it", () => {
    const sources = {
      "src/a/index.ts": [
        'import type { Value } from "../b/value.js";',
        'import { type OnlyType } from "../b/labels.js";',
        'export type { Value } from "../b/value.js";',
        'export { compute } from "../b/value.js";',
        "",
      ].join("\n"),
      "src/b/value.ts":
        "export function compute(): number { return 1; }\nexport type Value = number;\n",
      "src/b/labels.ts": "export type OnlyType = string;\n",
    };
    const graph = graphOf(sources);

    expect(graph.runtimeEdges.map((edge) => `${edge.from} -> ${edge.to}`).sort()).toEqual(
      ["src/a/index.ts -> src/b/value.ts"].sort(),
    );
    expect(graph.typeOnlyEdges.map((edge) => `${edge.from} -> ${edge.to}`).sort()).toEqual(
      [
        "src/a/index.ts -> src/b/labels.ts",
        "src/a/index.ts -> src/b/value.ts",
        "src/a/index.ts -> src/b/value.ts",
      ].sort(),
    );
  });

  it("reads a dynamic import as a runtime edge and a side-effect import as one too", () => {
    const references = parseModuleReferences(
      [
        'import "../b/value.js";',
        'const load = async () => await import("../b/labels.js");',
        "",
      ].join("\n"),
      "src/a/index.ts",
    );

    expect(references.map((reference) => `${reference.kind}:${reference.specifier}`)).toEqual([
      "import:../b/value.js",
      "dynamic-import:../b/labels.js",
    ]);
  });
});

describe("[AI-10] runtime cycles", () => {
  it("reports the six-file cycle the task removed, written as a closed chain", () => {
    const sources = {
      "src/proxy/index.ts": 'export { Registry } from "./proxy-runtime-registry.js";\n',
      "src/proxy/proxy-runtime-registry.ts":
        'import { TrafficLogService } from "../logging/index.js";\n',
      "src/logging/index.ts": 'export { TaskMatcher } from "./task-matcher.js";\n',
      "src/logging/task-matcher.ts": 'import { endpointKind } from "../proxy/index.js";\n',
    };
    const cycles = findRuntimeCycles(graphOf(sources));

    const chains = cycles.map((cycle) => formatChain(cycle));
    expect(chains).toContain(
      [
        "src/logging/index.ts",
        "src/logging/task-matcher.ts",
        "src/proxy/index.ts",
        "src/proxy/proxy-runtime-registry.ts",
        "src/logging/index.ts",
      ].join(" -> "),
    );

    const violations = violationsOf(sources);
    expect(violations[0]?.rule).toBe("no-runtime-import-cycles");
    expect(formatChain(violations[0]?.chain ?? [])).toContain("src/proxy/index.ts");
  });

  it("accepts the fixed direction: storage imports a leaf, never the barrel", () => {
    const sources = {
      "src/proxy/index.ts": 'export { Registry } from "./proxy-runtime-registry.js";\n',
      "src/proxy/proxy-runtime-registry.ts":
        'import { TrafficLogService } from "../logging/index.js";\n',
      "src/proxy/protocol/analysis.ts": 'import { isRecord } from "../../shared/index.js";\n',
      "src/logging/index.ts": 'export { TaskMatcher } from "./task-matcher.js";\n',
      "src/logging/task-matcher.ts":
        'import { endpointKind } from "../proxy/protocol/analysis.js";\n',
      "src/logging/traffic-log-service.ts": 'import { TaskMatcher } from "./task-matcher.js";\n',
      "src/shared/index.ts":
        'export function isRecord(value: unknown): boolean { return typeof value === "object"; }\n',
    };

    expect(findRuntimeCycles(graphOf(sources))).toEqual([]);
    expect(checkModuleBoundaries(graphOf(sources))).toEqual([]);
  });
});

describe("[AI-10] boundary rules", () => {
  it("flags a low-level helper that pulls the transport runtime through a barrel", () => {
    const sources = {
      "src/proxy/index.ts": 'export { Registry } from "./proxy-runtime-registry.js";\n',
      "src/proxy/proxy-runtime-registry.ts": "export class Registry {}\n",
      "src/logging/task-matcher.ts": 'import { Registry } from "../proxy/index.js";\n',
    };
    const violations = violationsOf(sources);
    const containment = violations.find(
      (violation) => violation.rule === "transport-runtime-containment",
    );

    expect(containment?.chain).toEqual([
      "src/logging/task-matcher.ts",
      "src/proxy/index.ts",
      "src/proxy/proxy-runtime-registry.ts",
    ]);
    expect(formatChain(containment?.chain ?? [])).toContain("src/proxy/proxy-runtime-registry.ts");
    expect(containment?.detail).toContain("Only the control plane may hold");
  });

  it("lets the control plane hold the runtime and lets proxy reach storage", () => {
    const sources = {
      "src/proxy/index.ts": 'export { Registry } from "./proxy-runtime-registry.js";\n',
      "src/proxy/proxy-runtime-registry.ts":
        'import { TrafficLogService } from "../logging/index.js";\n',
      "src/proxy/proxy-listener.ts": "export class Listener {}\n",
      "src/proxy/proxy-manager.ts": 'import { Registry } from "./proxy-runtime-registry.js";\n',
      "src/logging/index.ts": "export class TrafficLogService {}\n",
      "src/app/runtime.ts": 'import { Registry } from "../proxy/index.js";\n',
    };

    expect(checkModuleBoundaries(graphOf(sources))).toEqual([]);
  });

  it("flags imports that cross the transport, storage and control-plane boundary", () => {
    const sources = {
      "src/shared/paths.ts": 'import { helper } from "../proxy/protocol/analysis.js";\n',
      "src/proxy/protocol/analysis.ts": "export function helper(): number { return 1; }\n",
      "src/persistence/repository.ts": 'import { QueryService } from "../maintenance/query.js";\n',
      "src/maintenance/query.ts": "export class QueryService {}\n",
      "src/logging/redaction.ts": 'import { start } from "../../electron/index.js";\n',
      "electron/index.ts": "export function start(): void {}\n",
    };
    const violations = violationsOf(sources);
    const rules = violations.map((violation) => violation.rule);

    expect(rules).toContain("domain-direction");
    expect(
      violations
        .filter((violation) => violation.rule === "domain-direction")
        .map((violation) => formatChain(violation.chain))
        .sort(),
    ).toEqual(
      [
        "src/logging/redaction.ts -> electron/index.ts",
        "src/persistence/repository.ts -> src/maintenance/query.ts",
        "src/shared/paths.ts -> src/proxy/protocol/analysis.ts",
      ].sort(),
    );
  });

  it("finds the runtime chain through intermediate modules", () => {
    const sources = {
      "src/a.ts": 'import { b } from "./b.js";\n',
      "src/b.ts": 'import { c } from "./c.js";\n',
      "src/c.ts": "export const c = 1;\n",
    };
    expect(findRuntimeChain(graphOf(sources), "src/a.ts", "src/c.ts")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(findRuntimeChain(graphOf(sources), "src/c.ts", "src/a.ts")).toEqual([]);
  });
});

describe("[AI-10] the checked-in tree", () => {
  const graph = buildProjectGraph(REPO_ROOT);

  it("has no runtime import or re-export cycle and no boundary violation", () => {
    expect(findRuntimeCycles(graph)).toEqual([]);
    expect(checkModuleBoundaries(graph)).toEqual([]);
  });

  it("keeps storage out of the proxy transport runtime", () => {
    const outsideTransport = [
      "config",
      "logging",
      "maintenance",
      "persistence",
      "pricing",
      "shared",
    ];
    const intoTransport = graph.runtimeEdges.filter(
      (edge) =>
        edge.to.startsWith("src/proxy/") &&
        outsideTransport.includes(edge.from.split("/")[1] ?? ""),
    );
    expect(intoTransport.length).toBeGreaterThan(0);
    for (const edge of intoTransport) {
      const reached = runtimeClosure(graph, edge.to);
      expect(
        reached.filter((module) => TRANSPORT_ROOT_MODULES.includes(module)),
        `${edge.from} reaches ${edge.to}`,
      ).toEqual([]);
    }
    expect(
      graph.runtimeEdges.some(
        (edge) => edge.from.startsWith("src/logging/") && edge.to === "src/proxy/index.ts",
      ),
    ).toBe(false);
  });

  it("loads the task identity helper on its own, without the proxy runtime", async () => {
    const payloadModule = await import("../../src/proxy/protocol/payload.js");
    const identity = taskIdentity({
      payload: { model: "gpt-5", messages: [{ role: "user", content: "hello" }] },
      headers: {},
      path: "/v1/chat/completions",
    });

    expect(typeof payloadModule.bytesPayload).toBe("function");
    expect(identity.kind).toBe("chat");
    expect(identity.exactKeys).toEqual([]);

    const closure = runtimeClosure(graph, "src/proxy/protocol/task-identity.ts");
    expect(closure.filter((module) => TRANSPORT_ROOT_MODULES.includes(module))).toEqual([]);
    expect(closure.some((module) => module.startsWith("src/logging/"))).toBe(false);
    expect(
      closure.every(
        (module) =>
          module.startsWith("src/shared/") ||
          module.startsWith("src/proxy/protocol/") ||
          module === "src/proxy/protocol/task-identity.ts",
      ),
    ).toBe(true);
    expect(closure).toContain("src/proxy/protocol/analysis.ts");
  });
});
