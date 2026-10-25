// Ownership test for the statistics filter bar: the first area of app.css that owns a
// single block instead of inheriting a share of the cumulative stack. Two things can
// regress there, and neither is visible to a typecheck or a screenshot alone:
//
//   - a later patch re-scatters the component by naming one of its classes from
//     another part of the sheet, restoring the cross-pass contests the consolidation
//     removed;
//   - a later patch changes what the consolidated block resolves to, which is a
//     cascade outcome rather than a value anyone writes down.
//
// The first half is a static scan of the sheet; the second half reads the composed
// layout back out of a real page at every breakpoint and compares it with the values
// the pre-consolidation sheet produced.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { statisticsBaselineFixtures } from "./admin-ui-fixture.js";
import { baseUrl, browser, closeStubAdminServer, startStubAdminServer } from "./admin-ui-server.js";

const STATIC_DIR = path.resolve("src/admin/static");
const SHEET = path.join(STATIC_DIR, "app.css");
const MARKUP = path.join(STATIC_DIR, "index.html");

/** Classes the component owns; no rule outside its block may name one of them. */
const OWNED_CLASSES = [
  "stats-filters",
  "stats-filter-group",
  "stats-filter-time",
  "stats-filter-label",
  "stats-filter-summary",
  "stats-date-row",
  "stats-date-separator",
  "stats-presets",
  "stats-presets-group",
  "stats-live",
];

/** Classes the filter bar no longer renders; their rules were deleted, not kept. */
const REMOVED_CLASSES = ["stats-filter-data", "stats-select-grid", "stats-filter-actions"];

const BLOCK_START = "COMPONENT: statistics filter bar";
const BLOCK_END = "END COMPONENT: statistics filter bar";

/**
 * Every `!important` the block carries, in source order. Each one is a declaration
 * that has to beat something the component does not own - the shared `label`/`input`
 * element rules, or an earlier layout the same block still keeps for a wider range -
 * so adding one is a cascade decision and has to show up in this diff first.
 */
const IMPORTANT_DECLARATIONS = [
  "@media (min-width: 601px) .stats-date-row { flex: 0 0 auto }",
  "@media (min-width: 601px) .stats-date-row { grid-template-columns: 155px auto 155px auto }",
  "@media (min-width: 601px) .stats-date-row label, .stats-date-row input { width: 155px }",
  "@media (min-width: 601px) .stats-date-row label, .stats-date-row input { min-width: 155px }",
  "@media (min-width: 601px) .stats-date-row label, .stats-date-row input { max-width: 155px }",
  "@media (min-width: 601px) .stats-live { align-self: end }",
  '.stats-live input[type="checkbox"] { width: 16px }',
  '.stats-live input[type="checkbox"] { min-width: 16px }',
  '.stats-live input[type="checkbox"] { max-width: 16px }',
  ".stats-filter-time { display: grid }",
  ".stats-filter-time { align-items: stretch }",
  ".stats-filter-time { gap: 6px }",
  ".stats-filter-time > .stats-filter-label { padding-bottom: 0 }",
  "@media (min-width: 601px) .stats-date-row { display: flex }",
  "@media (min-width: 601px) .stats-date-row { align-items: end }",
  "@media (min-width: 601px) .stats-date-row { gap: 8px }",
  "@media (max-width: 600px) .stats-date-row { display: grid }",
  "@media (max-width: 600px) .stats-date-row { grid-template-columns: 1fr }",
];

interface ScannedRule {
  /** 1-based line the rule's selector starts on. */
  line: number;
  /** Enclosing at-rule preludes, outermost first. */
  context: string[];
  /** Comma-separated selector list, whitespace collapsed. */
  selector: string;
  declarations: { name: string; value: string }[];
}

/**
 * Splits the sheet into style rules. It relies on the two invariants
 * `test-node/admin/static-source.test.ts` already enforces: a rule's selector group is
 * followed by `{` on the same line, and a rule closes on its own `}` line. Declarations
 * may wrap (prettier breaks a long `font:` list), so they are collected until the
 * terminating semicolon. Anything else throws with its line number instead of being
 * skipped, so a silent hole cannot make a containment assertion pass.
 */
function scanRules(css: string): ScannedRule[] {
  const rules: ScannedRule[] = [];
  const context: string[] = [];
  let prelude: string[] = [];
  let pending: string[] = [];
  let current: ScannedRule | undefined;
  let skipDepth = 0;
  let inComment = false;
  css.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    const lineNumber = index + 1;
    if (inComment) {
      if (line.includes("*/")) inComment = false;
      return;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inComment = true;
      return;
    }
    if (skipDepth > 0) {
      skipDepth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      return;
    }
    if (current === undefined) {
      if (line === "}") {
        context.pop();
        return;
      }
      if (!line.endsWith("{")) {
        if (line !== "") prelude.push(line);
        return;
      }
      const header = [...prelude, line.slice(0, -1)].join(" ").replace(/\s+/g, " ").trim();
      prelude = [];
      if (header.startsWith("@keyframes")) {
        skipDepth = 1;
        return;
      }
      if (header.startsWith("@")) {
        context.push(header);
        return;
      }
      current = { line: lineNumber, context: [...context], selector: header, declarations: [] };
      return;
    }
    if (line === "}") {
      if (pending.length > 0) {
        throw new Error(`app.css:${lineNumber} closes the rule before its declaration ends`);
      }
      rules.push(current);
      current = undefined;
      return;
    }
    if (line === "") return;
    pending.push(line);
    const text = pending.join(" ").trimEnd();
    if (!text.endsWith(";")) return;
    pending = [];
    const colon = text.indexOf(":");
    const name = text.slice(0, colon).trim();
    const value = text
      .slice(colon + 1)
      .trim()
      .slice(0, -1)
      .trim();
    if (colon < 0 || !/^[-a-z]+$/.test(name) || value === "") {
      throw new Error(`app.css:${lineNumber} is not a declaration: ${line}`);
    }
    current.declarations.push({ name, value });
  });
  return rules;
}

/** True when `text` names `name` as a class and not as the prefix of a longer one. */
const namesClass = (text: string, name: string): boolean =>
  new RegExp(`\\.${name}(?![A-Za-z0-9_-])`).test(text);

const namesAny = (text: string, names: string[]): boolean =>
  names.some((name) => namesClass(text, name));

/** The class tokens the markup renders, read from its `class` attributes. */
const markupClasses = (markup: string): Set<string> => {
  const classes = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) {
      if (token !== "") classes.add(token);
    }
  }
  return classes;
};

const describes = (rule: ScannedRule, declaration: { name: string; value: string }): string =>
  `${rule.context.join(" && ")} ${rule.selector} { ${declaration.name}: ${declaration.value.replace(
    / !important$/,
    "",
  )} }`.trim();

interface SheetScan {
  rules: ScannedRule[];
  /** 1-based line of the component banner and of its end marker. */
  startLine: number;
  endLine: number;
  inBlock: (rule: ScannedRule) => boolean;
}

async function readSheet(): Promise<SheetScan> {
  const css = await readFile(SHEET, "utf8");
  const lines = css.split("\n");
  const startLine = lines.findIndex((text) => text.includes(BLOCK_START)) + 1;
  const endLine = lines.findIndex((text) => text.includes(BLOCK_END)) + 1;
  if (startLine === 0 || endLine === 0)
    throw new Error("the statistics filter bar block marker is gone");
  return {
    rules: scanRules(css),
    startLine,
    endLine,
    inBlock: (rule) => rule.line > startLine && rule.line < endLine,
  };
}

describe("statistics filter bar ownership", () => {
  it("declares the component once, between one banner and one end marker", async () => {
    const css = await readFile(SHEET, "utf8");
    const markers = css
      .split("\n")
      .filter((text) => text.includes(BLOCK_START) || text.includes(BLOCK_END))
      .map((text) => (text.includes(BLOCK_END) ? "end" : "start"));
    expect(markers).toEqual(["start", "end"]);
  });

  it("keeps every rule that names one of its classes inside the block", async () => {
    const sheet = await readSheet();
    const outside = sheet.rules
      .filter((rule) => !sheet.inBlock(rule))
      .filter((rule) => namesAny(rule.selector, OWNED_CLASSES))
      .map((rule) => `app.css:${rule.line} ${rule.selector}`);
    expect(outside).toEqual([]);
    const inside = sheet.rules
      .filter((rule) => sheet.inBlock(rule))
      .filter((rule) => !namesAny(rule.selector, OWNED_CLASSES))
      .map((rule) => `app.css:${rule.line} ${rule.selector}`);
    expect(inside).toEqual([]);
  });

  it("sees the whole sheet when it scans it", async () => {
    const sheet = await readSheet();
    const owned = sheet.rules.filter((rule) => namesAny(rule.selector, OWNED_CLASSES));
    // Guards the containment assertion above: a scanner that dropped rules would find
    // no strays and no component either.
    expect(owned.length).toBeGreaterThan(40);
    expect(sheet.rules.length).toBeGreaterThan(600);
  });

  it("declares each property once per selector and context inside the block", async () => {
    const sheet = await readSheet();
    const seen = new Map<string, string>();
    const problems: string[] = [];
    for (const rule of sheet.rules.filter(sheet.inBlock)) {
      if (rule.context.length > 1) {
        problems.push(`${rule.selector} sits in ${rule.context.join(" inside ")}`);
      }
      for (const declaration of rule.declarations) {
        const key = describes(rule, declaration);
        const previous = seen.get(key);
        if (previous !== undefined) {
          problems.push(`${key} also declared at ${previous}`);
          continue;
        }
        seen.set(key, `line ${rule.line}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("carries only the important declarations the boundary needs", async () => {
    const sheet = await readSheet();
    const important = sheet.rules
      .filter(sheet.inBlock)
      .flatMap((rule) =>
        rule.declarations
          .filter((declaration) => declaration.value.endsWith("!important"))
          .map((declaration) => describes(rule, declaration)),
      );
    expect(important).toEqual(IMPORTANT_DECLARATIONS);
  });

  it("no longer mentions the classes the filter bar stopped rendering", async () => {
    const sheet = await readSheet();
    const rendered = markupClasses(await readFile(MARKUP, "utf8"));
    for (const name of REMOVED_CLASSES) {
      const selectors = sheet.rules
        .filter((rule) => namesClass(rule.selector, name))
        .map((rule) => `app.css:${rule.line} ${rule.selector}`);
      expect({ name, selectors }).toEqual({ name, selectors: [] });
      expect({ name, inMarkup: rendered.has(name) }).toEqual({ name, inMarkup: false });
    }
  });

  it("owns classes the markup still renders", async () => {
    const rendered = markupClasses(await readFile(MARKUP, "utf8"));
    const missing = OWNED_CLASSES.filter((name) => !rendered.has(name));
    expect(missing).toEqual([]);
  });
});

interface Probe {
  selector: string;
  property: string;
  expected: string;
}

interface TrackProbe {
  selector: string;
  tracks: number;
}

interface Breakpoint {
  width: number;
  probes: Probe[];
  tracks: TrackProbe[];
}

/**
 * The composed layout the pre-consolidation sheet produced, measured in Chromium at
 * the widths where one of the passes changed its mind. Values are read verbatim from
 * `getComputedStyle`, so the table uses longhands (`padding-top`, not `padding`) and
 * column counts rather than resolved track sizes.
 */
const BREAKPOINTS: Breakpoint[] = [
  {
    width: 1400,
    probes: [
      { selector: ".stats-filters", property: "display", expected: "grid" },
      { selector: ".stats-filters", property: "column-gap", expected: "18px" },
      { selector: ".stats-filters", property: "padding-top", expected: "18px" },
      { selector: ".stats-filters", property: "align-items", expected: "center" },
      { selector: ".stats-filter-time", property: "display", expected: "grid" },
      { selector: ".stats-filter-time", property: "align-items", expected: "stretch" },
      { selector: ".stats-filter-time", property: "column-gap", expected: "6px" },
      { selector: ".stats-date-row", property: "display", expected: "flex" },
      { selector: ".stats-date-row", property: "flex-wrap", expected: "wrap" },
      { selector: ".stats-date-row", property: "align-items", expected: "end" },
      { selector: ".stats-date-row", property: "column-gap", expected: "8px" },
      {
        selector: ".stats-date-row",
        property: "grid-template-columns",
        expected: "155px auto 155px auto",
      },
      { selector: ".stats-date-row > label", property: "display", expected: "grid" },
      { selector: ".stats-date-row > label", property: "row-gap", expected: "5px" },
      { selector: ".stats-date-row > label", property: "width", expected: "155px" },
      { selector: ".stats-date-row > label", property: "min-width", expected: "155px" },
      { selector: ".stats-date-row > label", property: "max-width", expected: "155px" },
      { selector: ".stats-date-row > label", property: "font-weight", expected: "600" },
      { selector: "#statsFrom", property: "width", expected: "155px" },
      { selector: "#statsFrom", property: "min-height", expected: "38px" },
      { selector: "#statsFrom", property: "padding-top", expected: "5px" },
      { selector: "#statsFrom", property: "padding-left", expected: "7px" },
      { selector: ".stats-date-row .stats-live", property: "display", expected: "flex" },
      { selector: ".stats-date-row .stats-live", property: "column-gap", expected: "6px" },
      { selector: ".stats-date-row .stats-live", property: "margin-left", expected: "14px" },
      { selector: ".stats-date-row .stats-live", property: "padding-bottom", expected: "7px" },
      { selector: ".stats-date-row .stats-live", property: "min-height", expected: "36px" },
      { selector: ".stats-date-separator", property: "display", expected: "block" },
      { selector: ".stats-date-separator", property: "padding-bottom", expected: "9px" },
      { selector: ".stats-filter-label", property: "font-size", expected: "12px" },
      { selector: ".stats-filter-label", property: "font-weight", expected: "700" },
      { selector: ".stats-filter-label", property: "text-transform", expected: "uppercase" },
      { selector: ".stats-filter-label", property: "letter-spacing", expected: "0.48px" },
      { selector: ".stats-presets", property: "display", expected: "flex" },
      { selector: ".stats-presets", property: "padding-top", expected: "3px" },
      { selector: ".stats-presets", property: "border-radius", expected: "8px" },
      {
        selector: ".stats-presets button.active",
        property: "background-color",
        expected: "rgb(255, 255, 255)",
      },
      { selector: ".stats-presets button.active", property: "color", expected: "rgb(29, 78, 216)" },
      { selector: ".stats-filter-summary", property: "font-size", expected: "13px" },
      { selector: ".stats-filter-summary", property: "color", expected: "rgb(102, 112, 133)" },
    ],
    tracks: [
      { selector: ".stats-filter-time", tracks: 2 },
      { selector: ".stats-filters", tracks: 1 },
    ],
  },
  {
    width: 900,
    probes: [
      { selector: ".stats-date-row", property: "display", expected: "flex" },
      { selector: ".stats-date-separator", property: "display", expected: "block" },
      { selector: "#statsFrom", property: "width", expected: "155px" },
    ],
    tracks: [
      // Above 1101px the label sits left of the date row; below it, it takes the row.
      { selector: ".stats-filter-time", tracks: 1 },
    ],
  },
  {
    width: 700,
    probes: [
      // 601px..800px: still the compact flex row, but the separator is already gone.
      { selector: ".stats-date-row", property: "display", expected: "flex" },
      { selector: ".stats-date-separator", property: "display", expected: "none" },
      { selector: ".stats-date-row > label", property: "width", expected: "155px" },
    ],
    tracks: [{ selector: ".stats-filter-time", tracks: 1 }],
  },
  {
    width: 520,
    probes: [
      { selector: ".stats-date-row", property: "display", expected: "grid" },
      { selector: ".stats-date-row", property: "column-gap", expected: "10px" },
      // The 800px rule alone hides the separator here; the 600px duplicate is gone.
      { selector: ".stats-date-separator", property: "display", expected: "none" },
      { selector: ".stats-date-row > label", property: "min-width", expected: "0px" },
      { selector: ".stats-date-row > label", property: "max-width", expected: "none" },
      { selector: "#statsFrom", property: "min-width", expected: "0px" },
      { selector: ".stats-date-row .stats-live", property: "margin-left", expected: "0px" },
      { selector: ".stats-date-row .stats-live", property: "padding-bottom", expected: "0px" },
      // The follow-now checkbox stays intrinsic at every width.
      { selector: ".stats-date-row .stats-live input", property: "width", expected: "16px" },
      { selector: ".stats-date-row .stats-live input", property: "min-width", expected: "16px" },
      { selector: ".stats-date-row .stats-live input", property: "max-width", expected: "16px" },
    ],
    tracks: [{ selector: ".stats-date-row", tracks: 1 }],
  },
];

beforeAll(startStubAdminServer);
afterAll(closeStubAdminServer);

describe("statistics filter bar composed layout", () => {
  it("resolves to the layout the scattered passes produced at every breakpoint", async () => {
    const problems: string[] = [];
    for (const breakpoint of BREAKPOINTS) {
      const probe = await browser.newPage({
        viewport: { width: breakpoint.width, height: 900 },
      });
      // Statistics polls on a timer, so a digest could otherwise land in the middle
      // of a refresh; frozen page time stops every timer for the reads below.
      await probe.clock.install();
      const fixtures = statisticsBaselineFixtures();
      await probe.route("**/api/usage-statistics/options*", (route) =>
        route.fulfill({ json: fixtures.options }),
      );
      await probe.route("**/api/usage-statistics/overview*", (route) =>
        route.fulfill({ json: fixtures.overview[0] }),
      );
      await probe.route("**/api/usage-statistics/trend*", (route) =>
        route.fulfill({ json: fixtures.trend }),
      );
      await probe.goto(`${baseUrl}/`, { waitUntil: "load" });
      await probe.locator('[data-tab="statistics"]').click();
      await probe.locator("#statsFollowNow").uncheck();
      await probe.locator("#statsFrom").fill("2026-01-05T18:30");
      await probe.locator("#statsTo").fill("2026-01-12T18:30");
      await probe.waitForSelector("#statsOverview .stat-card");
      // Hover and focus are artifacts of where the click landed.
      await probe.mouse.move(2, 2);
      await probe.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });

      const measured = await probe.evaluate(
        (plan) => {
          const read = (selector: string, property: string): string => {
            const element = document.querySelector(selector);
            if (element === null) return "missing element";
            return getComputedStyle(element).getPropertyValue(property).trim();
          };
          return {
            values: plan.probes.map((entry) => read(entry.selector, entry.property)),
            tracks: plan.tracks.map((entry) => {
              const element = document.querySelector(entry.selector);
              if (element === null) return -1;
              const value = getComputedStyle(element).getPropertyValue("grid-template-columns");
              if (value === "none") return 0;
              return value.split(" ").filter((part) => part !== "").length;
            }),
          };
        },
        { probes: breakpoint.probes, tracks: breakpoint.tracks },
      );
      await probe.close();

      breakpoint.probes.forEach((entry, index) => {
        const actual = measured.values[index];
        if (actual === entry.expected) return;
        problems.push(
          `${breakpoint.width}px ${entry.selector} { ${entry.property} }: expected ${entry.expected}, got ${String(actual)}`,
        );
      });
      breakpoint.tracks.forEach((entry, index) => {
        const actual = measured.tracks[index];
        if (actual === entry.tracks) return;
        problems.push(
          `${breakpoint.width}px ${entry.selector}: expected ${entry.tracks} grid columns, got ${String(actual)}`,
        );
      });
    }
    expect(problems).toEqual([]);
  }, 180_000);
});
