import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { statisticsBaselineFixtures } from "./admin-ui-fixture.js";
import {
  baseUrl,
  browser,
  closeStubAdminServer,
  closeTestPage,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

describe("CSS cascade neutrality (opt-in via CSS_CANDIDATE)", () => {
  const SAMPLED = [
    "display",
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "z-index",
    "float",
    "clear",
    "flex-direction",
    "flex-wrap",
    "justify-content",
    "align-items",
    "align-self",
    "order",
    "flex-grow",
    "flex-shrink",
    "flex-basis",
    "grid-template-columns",
    "grid-template-rows",
    "grid-auto-flow",
    "grid-column-start",
    "grid-column-end",
    "grid-row-start",
    "grid-row-end",
    "gap",
    "row-gap",
    "column-gap",
    "box-sizing",
    "width",
    "min-width",
    "max-width",
    "height",
    "min-height",
    "max-height",
    "aspect-ratio",
    "vertical-align",
    "visibility",
    "contain",
    "content-visibility",
    "contain-intrinsic-size",
    "overflow",
    "overflow-x",
    "overflow-y",
    "resize",
    "pointer-events",
    "cursor",
    "user-select",
    "accent-color",
    "color",
    "fill",
    "stroke",
    "opacity",
    "clip-path",
    "mask-image",
    "filter",
    "backdrop-filter",
    "box-shadow",
    "text-shadow",
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "font-size",
    "line-height",
    "font-family",
    "text-rendering",
    "letter-spacing",
    "word-spacing",
    "text-align",
    "text-indent",
    "text-transform",
    "text-overflow",
    "white-space",
    "word-break",
    "overflow-wrap",
    "hyphens",
    "direction",
    "writing-mode",
    "text-decoration-line",
    "text-decoration-style",
    "text-decoration-color",
    "text-decoration-thickness",
    "background-image",
    "background-position",
    "background-size",
    "background-repeat",
    "background-attachment",
    "background-origin",
    "background-clip",
    "background-color",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "border-top-width",
    "border-top-style",
    "border-top-color",
    "border-right-width",
    "border-right-style",
    "border-right-color",
    "border-bottom-width",
    "border-bottom-style",
    "border-bottom-color",
    "border-left-width",
    "border-left-style",
    "border-left-color",
    "border-radius",
    "outline-color",
    "outline-style",
    "outline-width",
    "outline-offset",
    "appearance",
    "-webkit-appearance",
    "scrollbar-color",
    "scrollbar-width",
    "transform",
    "transform-origin",
    "transition-property",
    "animation-name",
    "object-fit",
    "object-position",
  ];

  interface Digest {
    sigs: Record<string, number>;
    facts: Record<string, { n: number; who: string[] }>;
  }

  // Walks every measured state with one stylesheet and calls `read` at each
  // checkpoint. The neutrality check and the cascade census share this walk so both
  // look at exactly the same page states under the same frozen page clock.
  async function walkStates<StateT>(
    css: string,
    read: (probe: Page, label: string) => Promise<StateT>,
  ): Promise<Record<string, StateT>> {
    const out: Record<string, StateT> = {};
    for (const width of [1280, 1050, 780, 480]) {
      const probe = await browser.newPage({ viewport: { width, height: 900 } });
      // The metrics dialog polls on a timer, so a digest could otherwise land in
      // the middle of a refresh and differ from the other run. Freeze page time
      // and never advance it: no page timer ever fires during the walk.
      await probe.clock.install();
      // The statistics page only renders once its API is stubbed; the overview
      // fixture rotates across three payloads, so pin the first one to keep the
      // two runs comparable.
      const statisticsFixtures = statisticsBaselineFixtures();
      await probe.route("**/api/usage-statistics/options*", (route) =>
        route.fulfill({ json: statisticsFixtures.options }),
      );
      await probe.route("**/api/usage-statistics/overview*", (route) =>
        route.fulfill({ json: statisticsFixtures.overview[0] }),
      );
      await probe.route("**/api/usage-statistics/trend*", (route) =>
        route.fulfill({ json: statisticsFixtures.trend }),
      );
      await probe.route("**/static/app.css", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/css; charset=utf-8",
          body: css,
          headers: { "cache-control": "no-store" },
        }),
      );
      await probe.addStyleTag({
        content: "*,*::before,*::after{animation:none !important;transition:none !important}",
      });
      const collect = async (label: string) => {
        // Hover and focus are run-to-run artifacts of where the click landed, so
        // clear both before reading anything off the page.
        await probe.mouse.move(2, 2);
        await probe.evaluate(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
        });
        out[`${width}/${label}`] = await read(probe, label);
      };
      await probe.goto(`${baseUrl}/`, { waitUntil: "load" });
      // Auto refresh and the pending-row sweep rotate state between renders,
      // which would make two runs of the same sheet differ.
      await probe.evaluate(() => {
        const box = document.getElementById("autoRefreshLogs");
        if (box instanceof HTMLInputElement && box.checked) box.click();
      });
      await probe.waitForSelector(".target-card");
      await collect("proxy");
      await probe.click("[data-metrics-target]");
      await probe.waitForSelector("#metricsDialog[open]");
      // The metrics list arrives asynchronously; #metricsRefresh is disabled
      // while the request is in flight, so enabled means the dialog has settled.
      await probe.waitForFunction(() => {
        const button = document.getElementById("metricsRefresh");
        return button instanceof HTMLButtonElement && !button.disabled;
      });
      await collect("metrics-dialog");
      await probe.evaluate(() => {
        const dialog = document.getElementById("metricsDialog");
        if (dialog instanceof HTMLDialogElement) dialog.close();
      });
      await probe.click("[data-check-target]");
      await probe.waitForSelector("#targetCheckDialog[open]");
      // The model picker fills asynchronously and re-enables its button when done.
      await probe.waitForFunction(() => {
        const button = document.getElementById("targetCheckModels");
        return button instanceof HTMLButtonElement && !button.disabled;
      });
      await collect("target-check-dialog");
      await probe.evaluate(() => {
        const dialog = document.getElementById("targetCheckDialog");
        if (dialog instanceof HTMLDialogElement) dialog.close();
      });
      await probe.click('[data-tab="logs"]');
      await probe.waitForSelector(".log-group");
      await probe.locator(".log-group-caret").first().click();
      await probe.waitForSelector(".log-item");
      await collect("logs-expanded");
      await probe.locator(".log-group-head").first().click();
      await probe.waitForSelector("#pricingPanel .task-summary");
      await collect("task-panel");
      await probe.click('[data-tab="statistics"]');
      await probe.waitForSelector("#statsBreakdown");
      await collect("stats");
      const breakdownValues = await probe.evaluate(() =>
        Array.from(document.querySelectorAll("#statsBreakdown option"))
          .map((option) => (option instanceof HTMLOptionElement ? option.value : ""))
          .filter((value) => value !== ""),
      );
      for (const value of breakdownValues) {
        await probe.selectOption("#statsBreakdown", value);
        await probe.waitForTimeout(200);
        await collect(`stats-${value}`);
      }

      await probe.close();
    }
    return out;
  }

  async function readDigest(probe: Page): Promise<Digest> {
    return probe.evaluate((names: string[]) => {
      const sigs: Record<string, number> = {};
      const facts: Record<string, { n: number; who: string[] }> = {};
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const cs = getComputedStyle(el);
        const kind = el.tagName + "|" + el.className;
        let sig = "";
        for (const n of names) {
          const v = cs.getPropertyValue(n);
          sig += n + ":" + v + ";";
          const fact = n + ":" + v;
          facts[fact] ??= { n: 0, who: [] };
          facts[fact].n += 1;
          if (facts[fact].who.length < 3 && !facts[fact].who.includes(kind)) {
            facts[fact].who.push(kind);
          }
        }
        sigs[sig] = (sigs[sig] ?? 0) + 1;
      }
      return { sigs, facts };
    }, SAMPLED);
  }

  async function signaturesWithCss(css: string): Promise<Record<string, Digest>> {
    return walkStates(css, (probe) => readDigest(probe));
  }

  it.skipIf(!process.env["CSS_CANDIDATE"])(
    "candidate stylesheet must not change any computed-style count",
    async () => {
      const candidateFile = process.env["CSS_CANDIDATE"];
      if (candidateFile === undefined) return;
      const liveCss = await readFile(
        new URL("../../src/admin/static/app.css", import.meta.url),
        "utf8",
      );
      const candidateCss = await readFile(candidateFile, "utf8");
      const live = await signaturesWithCss(liveCss);
      const candidate = await signaturesWithCss(candidateCss);
      const problems: string[] = [];
      const boring =
        /: (normal|none|auto|0px|visible|static|start|stretch|baseline|1|row|nowrap|middle)$/i;
      for (const key of Object.keys(live)) {
        const a = live[key];
        const b = candidate[key];
        if (a === undefined || b === undefined) {
          problems.push(`${key}: checkpoint missing`);
          continue;
        }
        if (JSON.stringify(a.sigs) !== JSON.stringify(b.sigs)) {
          problems.push(`${key}: signature multiset changed`);
        }
        const factKeys = new Set([...Object.keys(a.facts), ...Object.keys(b.facts)]);
        for (const fact of factKeys) {
          const from = a.facts[fact]?.n ?? 0;
          const to = b.facts[fact]?.n ?? 0;
          if (from === to || boring.test(fact)) continue;
          const who = [
            ...new Set([...(b.facts[fact]?.who ?? []), ...(a.facts[fact]?.who ?? [])]),
          ].join(", ");
          problems.push(`${key}: ${fact} ${from} -> ${to} [${who}]`);
        }
      }
      expect(problems.slice(0, 30)).toEqual([]);
    },
    240_000,
  );
  interface CensusDecl {
    name: string;
    value: string;
    important: boolean;
  }

  interface CensusRule {
    order: number;
    selector: string;
    media: string[];
    supports: string[];
    declCount: number;
    decls: CensusDecl[];
  }

  interface CensusPair {
    n: number;
    by: string;
    prop: string;
    winner: number;
    loser: number;
    flipIfStripped: boolean;
    sameValue: boolean;
    who: string[];
  }

  interface CensusState {
    rules: CensusRule[];
    pairs: Record<string, CensusPair>;
    elements: number;
    unreadableSelectors: number;
    nestedRules: number;
  }

  // Opt-in planning tool for a layered restructure (CSS_CENSUS=1, optional
  // CSS_CENSUS_OUT=<path>). On today's unlayered sheet the cascade ranks by
  // importance, then specificity, then source order, so this records which two
  // declarations actually compete for the same element and which of those three
  // decided it. A pair decided by source order can be reproduced inside layers by
  // putting the later rule in the later layer; a pair decided by specificity cannot,
  // because crossing a layer boundary outranks specificity and would flip it. Pairs
  // whose two declarations already agree on the value are harmless either way.
  it.skipIf(!process.env["CSS_CENSUS"])(
    "cascade census records which declarations compete for the same element",
    async () => {
      const liveCss = await readFile(
        new URL("../../src/admin/static/app.css", import.meta.url),
        "utf8",
      );
      const read = async (probe: Page): Promise<CensusState> =>
        probe.evaluate((names: string[]) => {
          interface Decl {
            name: string;
            value: string;
            important: boolean;
          }
          interface RuleInfo {
            order: number;
            selector: string;
            media: string[];
            supports: string[];
            declCount: number;
            decls: Decl[];
          }
          interface PairInfo {
            n: number;
            by: string;
            prop: string;
            winner: number;
            loser: number;
            flipIfStripped: boolean;
            sameValue: boolean;
            who: string[];
          }
          interface Candidate {
            order: number;
            spec: [number, number, number];
            important: boolean;
            value: string;
          }
          const wanted = new Set(names);
          const rules: RuleInfo[] = [];
          const specificityCache = new Map<string, [number, number, number]>();
          // Counts id, class-level (class, attribute, pseudo-class, pseudo-element)
          // and type selectors. :where() adds nothing, and :not() is counted as one
          // class-level token instead of the specificity of its argument, which is
          // an approximation worth naming because it can only misreport a tie.
          const specificityOf = (part: string): [number, number, number] => {
            const cached = specificityCache.get(part);
            if (cached) return cached;
            const text = part.replace(/:where\([^)]*\)/g, "");
            let ids = 0;
            let classes = 0;
            let types = 0;
            ids += Array.from(text.matchAll(/#[\w-]+/g)).length;
            for (const match of text.matchAll(/\[[^\]]*\]|\.[\w-]+|::?[\w-]+(?:\([^)]*\))?/g)) {
              if (!match[0].startsWith("#")) classes += 1;
            }
            for (const match of text.matchAll(/(?:^|[\s>+~])[\w-]+/g)) {
              const token = match[0].trim();
              if (token && !/^[.#[]/.test(token)) types += 1;
            }
            const value: [number, number, number] = [ids, classes, types];
            specificityCache.set(part, value);
            return value;
          };
          const conditionCache = new Map<string, boolean>();
          const applies = (media: string[], supports: string[]) => {
            for (const condition of media) {
              let ok = conditionCache.get(condition);
              if (ok === undefined) {
                ok = window.matchMedia(condition).matches;
                conditionCache.set(condition, ok);
              }
              if (!ok) return false;
            }
            for (const condition of supports) {
              let ok = conditionCache.get(condition);
              if (ok === undefined) {
                ok = CSS.supports(condition);
                conditionCache.set(condition, ok);
              }
              if (!ok) return false;
            }
            return true;
          };
          let nestedRules = 0;
          const collect = (list: CSSRuleList, media: string[], supports: string[]) => {
            for (const rule of Array.from(list)) {
              if (rule instanceof CSSStyleRule) {
                if (rule.cssRules.length > 0) nestedRules += 1;
                const decls: Decl[] = [];
                for (const name of Array.from(rule.style)) {
                  if (!wanted.has(name)) continue;
                  decls.push({
                    name,
                    value: rule.style.getPropertyValue(name),
                    important: rule.style.getPropertyPriority(name) === "important",
                  });
                }
                rules.push({
                  order: rules.length,
                  selector: rule.selectorText,
                  media,
                  supports,
                  declCount: decls.length,
                  decls,
                });
              } else if (rule instanceof CSSMediaRule) {
                collect(rule.cssRules, media.concat(rule.conditionText), supports);
              } else if (rule instanceof CSSSupportsRule) {
                collect(rule.cssRules, media, supports.concat(rule.conditionText));
              }
            }
          };
          // Only the app stylesheet counts: the animation killer this harness adds
          // and any inline style would otherwise show up as a winner everywhere.
          for (const sheet of Array.from(document.styleSheets)) {
            const href = sheet.href ?? "";
            if (!href.includes("/static/app.css")) continue;
            collect(sheet.cssRules, [], []);
          }
          const owners = new Map<Element, { order: number; spec: [number, number, number] }[]>();
          let unreadableSelectors = 0;
          for (const rule of rules) {
            if (!applies(rule.media, rule.supports)) continue;
            let found: Element[];
            try {
              found = Array.from(document.querySelectorAll(rule.selector));
            } catch {
              unreadableSelectors += 1;
              continue;
            }
            const parts = rule.selector.split(",").map((part) => part.trim());
            for (const element of found) {
              let spec: [number, number, number] | null = null;
              for (const part of parts) {
                try {
                  if (element.matches(part)) {
                    spec = specificityOf(part);
                    break;
                  }
                } catch {
                  unreadableSelectors += 1;
                }
              }
              const entry = {
                order: rule.order,
                spec: spec ?? specificityOf(parts[0] ?? rule.selector),
              };
              const list = owners.get(element) ?? [];
              list.push(entry);
              owners.set(element, list);
            }
          }
          // Today every declaration is unlayered, so the ranking is exactly
          // importance, then specificity, then source order.
          const rank = (a: Candidate, b: Candidate) =>
            (b.important ? 1 : 0) - (a.important ? 1 : 0) ||
            b.spec[0] - a.spec[0] ||
            b.spec[1] - a.spec[1] ||
            b.spec[2] - a.spec[2] ||
            b.order - a.order;
          const pairs: Record<string, PairInfo> = {};
          for (const [element, entries] of owners) {
            const buckets = new Map<string, Candidate[]>();
            for (const entry of entries) {
              const rule = rules[entry.order];
              if (rule === undefined) continue;
              for (const decl of rule.decls) {
                const bucket = buckets.get(decl.name) ?? [];
                bucket.push({
                  order: entry.order,
                  spec: entry.spec,
                  important: decl.important,
                  value: decl.value,
                });
                buckets.set(decl.name, bucket);
              }
            }
            const kind = element.tagName + "|" + element.className;
            for (const [prop, bucket] of buckets) {
              if (bucket.length < 2) continue;
              const ranked = bucket.slice().sort(rank);
              const winner = ranked[0];
              const loser = ranked[1];
              if (winner === undefined || loser === undefined) continue;
              if (winner.order === loser.order) continue;
              let by = "order";
              if (winner.important && loser.important) by = "important-order";
              else if (winner.important !== loser.important) by = "importance";
              else if (winner.spec.join(",") !== loser.spec.join(",")) by = "specificity";
              const stripped = ranked.map((candidate, index) =>
                index === 0 ? { ...candidate, important: false } : candidate,
              );
              const top = stripped.sort(rank)[0];
              const flipIfStripped = top !== undefined && top.order !== winner.order;
              const key = `${winner.order}>${loser.order}|${prop}|${by}`;
              const record: PairInfo = pairs[key] ?? {
                n: 0,
                by,
                prop,
                winner: winner.order,
                loser: loser.order,
                flipIfStripped: false,
                sameValue: winner.value === loser.value,
                who: [],
              };
              record.n += 1;
              record.flipIfStripped = record.flipIfStripped || flipIfStripped;
              if (record.who.length < 3 && !record.who.includes(kind)) record.who.push(kind);
              pairs[key] = record;
            }
          }
          return { rules, pairs, elements: owners.size, unreadableSelectors, nestedRules };
        }, SAMPLED);
      let rules: CensusRule[] = [];
      const pairs: Record<string, CensusPair> = {};
      const states: Record<string, { elements: number; unreadable: number; nested: number }> = {};
      await walkStates(liveCss, async (probe, label) => {
        const state = await read(probe);
        if (rules.length === 0) rules = state.rules;
        states[label] = {
          elements: state.elements,
          unreadable: state.unreadableSelectors,
          nested: state.nestedRules,
        };
        for (const [key, value] of Object.entries(state.pairs)) {
          const record: CensusPair = pairs[key] ?? {
            n: 0,
            by: value.by,
            prop: value.prop,
            winner: value.winner,
            loser: value.loser,
            flipIfStripped: false,
            sameValue: value.sameValue,
            who: [],
          };
          record.n += value.n;
          record.flipIfStripped = record.flipIfStripped || value.flipIfStripped;
          for (const kind of value.who) {
            if (!record.who.includes(kind) && record.who.length < 4) record.who.push(kind);
          }
          pairs[key] = record;
        }
      });
      const target = process.env["CSS_CENSUS_OUT"];
      if (target) await writeFile(target, JSON.stringify({ rules, pairs, states }));
      const byCounts: Record<string, number> = {};
      for (const pair of Object.values(pairs)) {
        byCounts[pair.by] = (byCounts[pair.by] ?? 0) + pair.n;
      }
      console.log("census rules:", rules.length, "| competing pairs:", Object.keys(pairs).length);
      console.log("decided by:", JSON.stringify(byCounts));
      console.log("states:", JSON.stringify(states));
      expect(rules.length).toBeGreaterThan(700);
      expect(Object.keys(pairs).length).toBeGreaterThan(50);
    },
    900_000,
  );
});
