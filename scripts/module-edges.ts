import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Project module graph built from the TypeScript AST.
 *
 * Internal specifiers in this repository are written with the compiled `.js`
 * extension while the sources are `.ts`, so a resolver that does not map
 * `./x.js` onto `./x.ts` and `./x/index.ts` sees no edges at all and reports a
 * clean graph. Every rule in this file depends on that mapping being right, and
 * `test-node/logging/module-boundaries.test.ts` pins it.
 *
 * Only runtime edges are checked: `import type`, `export type` and a named
 * import whose every element is `type`-marked cannot run anything, so they are
 * excluded from cycle and boundary analysis. They are still returned so the
 * report can show how much of the graph they make up.
 */

export type ModuleReferenceKind = "import" | "re-export" | "dynamic-import";

export interface ModuleReference {
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  readonly typeOnly: boolean;
}

export interface ModuleEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: ModuleReferenceKind;
}

export interface ProjectGraph {
  readonly modules: readonly string[];
  readonly runtimeEdges: readonly ModuleEdge[];
  readonly typeOnlyEdges: readonly ModuleEdge[];
}

export interface BoundaryViolation {
  readonly rule: string;
  readonly chain: readonly string[];
  readonly detail: string;
}

/** Modules that own the proxy runtime: listener, manager, registry, pipeline. */
export const TRANSPORT_ROOT_MODULES: readonly string[] = [
  "src/proxy/proxy-listener.ts",
  "src/proxy/proxy-manager.ts",
  "src/proxy/proxy-runtime-registry.ts",
  "src/proxy/proxy-request-pipeline.ts",
];

/** Domains that assemble the application and are allowed to hold the runtime. */
const CONTROL_PLANE_DOMAINS: readonly string[] = ["admin", "app", "cli"];
/** Aggregation and startup files; they are roots, not domain members. */
const ENTRY_MODULES: readonly string[] = ["src/index.ts", "src/main.ts"];

/**
 * Domains whose runtime must never reach these targets. The list is the
 * transport/storage/control-plane boundary from
 * `docs/current/contracts/module-boundaries.md` written as data.
 */
const FORBIDDEN_TARGETS: Readonly<Record<string, readonly string[]>> = {
  config: ["admin", "app", "cli", "proxy", "logging", "maintenance"],
  logging: ["admin", "app", "cli"],
  maintenance: ["admin", "app", "cli"],
  persistence: ["admin", "app", "cli", "logging", "maintenance"],
  pricing: ["admin", "app", "cli"],
  proxy: ["admin", "app", "cli"],
  shared: [
    "admin",
    "app",
    "cli",
    "config",
    "logging",
    "maintenance",
    "persistence",
    "pricing",
    "proxy",
  ],
};

const SCANNED_DIRECTORIES: readonly string[] = ["src", "electron"];

/** Elementary cycles per strongly connected component before the report gives up. */
const MAX_REPORTED_CYCLES = 64;

function toPosixRelative(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replaceAll("\\", "/");
}

function rewriteRelativeSpecifier(fromModule: string, specifier: string): string {
  const directory = path.posix.dirname(fromModule);
  const joined = path.posix.normalize(path.posix.join(directory, specifier));
  if (joined.endsWith(".js")) {
    return `${joined.slice(0, -3)}.ts`;
  }
  if (joined.endsWith(".mjs")) {
    return `${joined.slice(0, -4)}.mts`;
  }
  if (joined.endsWith(".cjs")) {
    return `${joined.slice(0, -4)}.cts`;
  }
  return joined;
}

/**
 * Resolve one internal specifier against the set of known modules. A `.js`
 * specifier may name a sibling file or a directory barrel, so both spellings are
 * tried before giving up; anything that does not start with `.` is an external
 * package and is not a project edge.
 */
export function resolveModuleReference(
  fromModule: string,
  specifier: string,
  knownModules: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = rewriteRelativeSpecifier(fromModule, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.mts"),
  ];
  return candidates.find((candidate) => knownModules.has(candidate));
}

function dynamicImportTarget(node: ts.Node): ts.StringLiteral | undefined {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return undefined;
  }
  const firstArgument = node.arguments[0];
  return firstArgument !== undefined && ts.isStringLiteral(firstArgument)
    ? firstArgument
    : undefined;
}

/** Read every module reference of one source file out of its AST. */
export function parseModuleReferences(
  sourceText: string,
  moduleName: string,
): readonly ModuleReference[] {
  const sourceFile = ts.createSourceFile(
    moduleName,
    sourceText,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.TS,
  );
  const references: ModuleReference[] = [];

  const collectImport = (node: ts.ImportDeclaration): void => {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) {
      return;
    }
    const clause = node.importClause;
    if (clause === undefined) {
      // `import "./x.js"` runs the module for its side effects.
      references.push({ specifier: moduleSpecifier.text, kind: "import", typeOnly: false });
      return;
    }
    const namedBindings = clause.namedBindings;
    const everyElementIsTypeOnly =
      namedBindings !== undefined &&
      ts.isNamedImports(namedBindings) &&
      namedBindings.elements.length > 0 &&
      namedBindings.elements.every((element) => element.isTypeOnly);
    references.push({
      specifier: moduleSpecifier.text,
      kind: "import",
      typeOnly: clause.phaseModifier === ts.SyntaxKind.TypeKeyword || everyElementIsTypeOnly,
    });
  };

  const collectExport = (node: ts.ExportDeclaration): void => {
    const moduleSpecifier = node.moduleSpecifier;
    if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) {
      return;
    }
    references.push({
      specifier: moduleSpecifier.text,
      kind: "re-export",
      typeOnly: node.isTypeOnly,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      collectImport(node);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      collectExport(node);
      return;
    }
    const literal = dynamicImportTarget(node);
    if (literal !== undefined) {
      references.push({ specifier: literal.text, kind: "dynamic-import", typeOnly: false });
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return references;
}

function assembleGraph(sources: ReadonlyMap<string, string>): ProjectGraph {
  const modules = [...sources.keys()].sort();
  const knownModules = new Set(modules);
  const runtimeEdges: ModuleEdge[] = [];
  const typeOnlyEdges: ModuleEdge[] = [];

  for (const module of modules) {
    const sourceText = sources.get(module) ?? "";
    for (const reference of parseModuleReferences(sourceText, module)) {
      const target = resolveModuleReference(module, reference.specifier, knownModules);
      if (target === undefined) {
        continue;
      }
      const edge: ModuleEdge = { from: module, to: target, kind: reference.kind };
      (reference.typeOnly ? typeOnlyEdges : runtimeEdges).push(edge);
    }
  }

  return { modules, runtimeEdges, typeOnlyEdges };
}

/** Build the graph from sources held in memory, keyed by project-relative path. */
export function buildGraphFromSources(sources: ReadonlyMap<string, string>): ProjectGraph {
  return assembleGraph(sources);
}

function listProjectFiles(rootDir: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) {
        found.push(toPosixRelative(rootDir, absolutePath));
      }
    }
  };
  for (const directory of SCANNED_DIRECTORIES) {
    const absoluteDirectory = path.join(rootDir, directory);
    if (fs.existsSync(absoluteDirectory)) {
      walk(absoluteDirectory);
    }
  }
  return found.sort();
}

/** Build the graph from the checked-in tree. */
export function buildProjectGraph(rootDir: string): ProjectGraph {
  const sources = new Map<string, string>();
  for (const module of listProjectFiles(rootDir)) {
    sources.set(module, fs.readFileSync(path.join(rootDir, module), "utf8"));
  }
  return assembleGraph(sources);
}

function adjacency(graph: ProjectGraph, runtime: boolean): Map<string, string[]> {
  const edges = runtime ? graph.runtimeEdges : graph.typeOnlyEdges;
  const map = new Map<string, string[]>();
  for (const module of graph.modules) {
    map.set(module, []);
  }
  for (const edge of edges) {
    const targets = map.get(edge.from);
    if (targets !== undefined && !targets.includes(edge.to)) {
      targets.push(edge.to);
    }
  }
  for (const targets of map.values()) {
    targets.sort();
  }
  return map;
}

/** Every module the given one can reach at runtime, in path order. */
export function runtimeClosure(graph: ProjectGraph, module: string): string[] {
  const neighbours = adjacency(graph, true);
  const reached = new Set<string>();
  const queue: string[] = [module];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || reached.has(current)) {
      continue;
    }
    reached.add(current);
    for (const target of neighbours.get(current) ?? []) {
      queue.push(target);
    }
  }
  reached.delete(module);
  return [...reached].sort();
}

function stronglyConnectedComponents(graph: ProjectGraph): string[][] {
  const neighbours = adjacency(graph, true);
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const strongConnect = (module: string): void => {
    counter += 1;
    indexOf.set(module, counter);
    lowLink.set(module, counter);
    stack.push(module);
    onStack.add(module);

    for (const target of neighbours.get(module) ?? []) {
      if (indexOf.has(target)) {
        if (onStack.has(target)) {
          lowLink.set(module, Math.min(lowLink.get(module) ?? counter, indexOf.get(target) ?? 0));
        }
      } else {
        strongConnect(target);
        lowLink.set(
          module,
          Math.min(lowLink.get(module) ?? counter, lowLink.get(target) ?? counter),
        );
      }
    }

    if (lowLink.get(module) === indexOf.get(module)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop();
        if (member === undefined) {
          break;
        }
        onStack.delete(member);
        component.push(member);
        if (member === module) {
          break;
        }
      }
      components.push(component.sort());
    }
  };

  for (const module of graph.modules) {
    if (!indexOf.has(module)) {
      strongConnect(module);
    }
  }
  return components.sort((left, right) => left.join(",").localeCompare(right.join(",")));
}

/**
 * Enumerate the elementary cycles inside one component. A cycle is only collected
 * when the starting module is the lexicographically smallest member of it, which
 * removes the same cycle written from a different starting point.
 */
function cyclesWithinComponent(
  component: readonly string[],
  neighbours: Map<string, string[]>,
): string[][] {
  const members = new Set(component);
  const cycles: string[][] = [];

  for (const start of component) {
    const path: string[] = [];
    const onPath = new Set<string>();

    const extend = (module: string): void => {
      path.push(module);
      onPath.add(module);
      for (const target of neighbours.get(module) ?? []) {
        if (!members.has(target)) {
          continue;
        }
        if (target === start) {
          cycles.push([...path, start]);
          continue;
        }
        if (target <= start || onPath.has(target) || cycles.length >= MAX_REPORTED_CYCLES) {
          continue;
        }
        extend(target);
      }
      path.pop();
      onPath.delete(module);
    };

    extend(start);
    if (cycles.length >= MAX_REPORTED_CYCLES) {
      break;
    }
  }

  return cycles;
}

function representativeCycle(
  component: readonly string[],
  neighbours: Map<string, string[]>,
): string[] {
  const start = component[0] ?? "";
  const visited = new Map<string, string[]>();
  const queue: string[][] = [[start]];
  while (queue.length > 0) {
    const chain = queue.shift() ?? [];
    const last = chain[chain.length - 1] ?? "";
    for (const target of neighbours.get(last) ?? []) {
      if (target === start) {
        return [...chain, start];
      }
      if (visited.has(target)) {
        continue;
      }
      const nextChain = [...chain, target];
      visited.set(target, nextChain);
      queue.push(nextChain);
    }
  }
  return [start, start];
}

/** All runtime import and re-export cycles, each written as a closed chain. */
export function findRuntimeCycles(graph: ProjectGraph): string[][] {
  const neighbours = adjacency(graph, true);
  const cycles: string[][] = [];

  for (const component of stronglyConnectedComponents(graph)) {
    const selfLoop = (neighbours.get(component[0] ?? "") ?? []).includes(component[0] ?? "");
    if (component.length === 1 && !selfLoop) {
      continue;
    }
    if (component.length > 12) {
      cycles.push(representativeCycle(component, neighbours));
      continue;
    }
    cycles.push(...cyclesWithinComponent(component, neighbours));
  }

  return cycles.sort((left, right) => left.join("\n").localeCompare(right.join("\n")));
}

function domainOf(module: string): string {
  const parts = module.split("/");
  const first = parts[0] ?? "";
  if (first === "src") {
    const domain = parts[1];
    return domain === undefined || domain.endsWith(".ts") ? "root" : domain;
  }
  return first;
}

/** Shortest runtime chain from one module to another, inclusive of both ends. */
export function findRuntimeChain(graph: ProjectGraph, from: string, to: string): readonly string[] {
  const neighbours = adjacency(graph, true);
  const visited = new Map<string, string[]>();
  const queue: string[][] = [[from]];
  visited.set(from, [from]);

  while (queue.length > 0) {
    const chain = queue.shift() ?? [];
    const last = chain[chain.length - 1] ?? "";
    for (const target of neighbours.get(last) ?? []) {
      if (visited.has(target)) {
        continue;
      }
      const nextChain = [...chain, target];
      if (target === to) {
        return nextChain;
      }
      visited.set(target, nextChain);
      queue.push(nextChain);
    }
  }

  return [];
}

function containmentViolations(graph: ProjectGraph): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const edge of graph.runtimeEdges) {
    const sourceDomain = domainOf(edge.from);
    if (
      sourceDomain === "proxy" ||
      CONTROL_PLANE_DOMAINS.includes(sourceDomain) ||
      ENTRY_MODULES.includes(edge.from)
    ) {
      continue;
    }
    if (!edge.to.startsWith("src/proxy/")) {
      continue;
    }
    const reached = runtimeClosure(graph, edge.to);
    const reachedRoots = TRANSPORT_ROOT_MODULES.filter((root) => reached.includes(root));
    if (reachedRoots.length === 0) {
      continue;
    }
    const root = reachedRoots[0] ?? "";
    const innerChain = findRuntimeChain(graph, edge.to, root);
    if (innerChain.length === 0) {
      continue;
    }
    violations.push({
      rule: "transport-runtime-containment",
      chain: [edge.from, ...innerChain],
      detail:
        `${edge.from} pulls the proxy runtime through ${edge.to}. ` +
        `Only the control plane may hold ${root}; low-level code must import the leaf module that owns the helper.`,
    });
  }

  return violations;
}

function domainDirectionViolations(graph: ProjectGraph): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const edge of graph.runtimeEdges) {
    const sourceDomain = domainOf(edge.from);
    const targetDomain = domainOf(edge.to);
    if (ENTRY_MODULES.includes(edge.from) || sourceDomain === targetDomain) {
      continue;
    }

    const forbidden = FORBIDDEN_TARGETS[sourceDomain] ?? [];
    const crossesOwnBoundary =
      targetDomain === "electron" || (targetDomain !== "root" && forbidden.includes(targetDomain));

    if (!crossesOwnBoundary) {
      continue;
    }

    violations.push({
      rule: "domain-direction",
      chain: [edge.from, edge.to],
      detail:
        `${sourceDomain} must not depend on ${targetDomain}; ${edge.from} imports ${edge.to} ` +
        `(kind ${edge.kind}).`,
    });
  }

  return violations;
}

/** Runtime cycles and out-of-boundary imports, each with the chain that caused it. */
export function checkModuleBoundaries(graph: ProjectGraph): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const cycle of findRuntimeCycles(graph)) {
    violations.push({
      rule: "no-runtime-import-cycles",
      chain: cycle,
      detail: `runtime import/re-export cycle over ${cycle.length - 1} modules`,
    });
  }

  const containment = containmentViolations(graph);
  const direction = domainDirectionViolations(graph);
  const seen = new Set(violations.map((violation) => violation.chain.join("\n")));
  for (const violation of [...containment, ...direction]) {
    const key = violation.chain.join("\n");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    violations.push(violation);
  }

  return violations;
}

export function formatChain(chain: readonly string[]): string {
  return chain.join(" -> ");
}
