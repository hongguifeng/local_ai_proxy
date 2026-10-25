import path from "node:path";

import {
  buildProjectGraph,
  checkModuleBoundaries,
  formatChain,
  runtimeClosure,
  TRANSPORT_ROOT_MODULES,
} from "./module-edges.js";

/**
 * Static gate for the runtime module graph: it fails when `src` contains a
 * runtime import/re-export cycle or an import that crosses the transport,
 * storage and control-plane boundary, and it prints the concrete dependency
 * chain for every finding. Type-only imports are excluded because they cannot
 * load anything.
 *
 * Run it with `npm run check:modules`. The same rules are exercised against
 * deliberately broken sources in `test-node/logging/module-boundaries.test.ts`.
 */

const ROOT_DIR = path.resolve(import.meta.dirname, "..");

function parseClosureRequest(argv: readonly string[]): string | undefined {
  const flagIndex = argv.indexOf("--closure");
  if (flagIndex === -1) {
    return undefined;
  }
  const module = argv[flagIndex + 1];
  if (module === undefined) {
    throw new Error(
      "--closure needs a module path, for example --closure src/proxy/protocol/analysis.ts",
    );
  }
  return module;
}

function reportClosure(graph: ReturnType<typeof buildProjectGraph>, module: string): number {
  const known = graph.modules.includes(module);
  if (!known) {
    console.error(`unknown module: ${module}`);
    return 1;
  }
  const closure = runtimeClosure(graph, module);
  const reachedRoots = TRANSPORT_ROOT_MODULES.filter((root) => closure.includes(root));

  console.log(`runtime closure of ${module}: ${closure.length} modules`);
  for (const reached of closure) {
    console.log(`  ${reached}`);
  }
  console.log(
    reachedRoots.length === 0
      ? `reaches no transport root: ${module} loads on its own`
      : `reaches transport roots: ${reachedRoots.join(", ")}`,
  );
  return reachedRoots.length === 0 ? 0 : 1;
}

function main(argv: readonly string[]): number {
  const graph = buildProjectGraph(ROOT_DIR);
  const closureRequest = parseClosureRequest(argv);
  if (closureRequest !== undefined) {
    return reportClosure(graph, closureRequest);
  }

  const violations = checkModuleBoundaries(graph);

  console.log(
    `scanned ${graph.modules.length} modules: ${graph.runtimeEdges.length} runtime edges, ` +
      `${graph.typeOnlyEdges.length} type-only edges`,
  );

  if (violations.length === 0) {
    console.log("runtime cycles: 0; boundary violations: 0");
    return 0;
  }

  const cycles = violations.filter((violation) => violation.rule === "no-runtime-import-cycles");
  const boundaries = violations.filter(
    (violation) => violation.rule !== "no-runtime-import-cycles",
  );
  console.log(`runtime cycles: ${cycles.length}; boundary violations: ${boundaries.length}`);

  for (const violation of cycles) {
    console.log(`\ncycle (${violation.rule}) ${violation.detail}`);
    console.log(`  ${formatChain(violation.chain)}`);
  }
  for (const violation of boundaries) {
    console.log(`\nboundary violation (${violation.rule}) ${violation.detail}`);
    console.log(`  ${formatChain(violation.chain)}`);
  }

  return 1;
}

process.exitCode = main(process.argv.slice(2));
