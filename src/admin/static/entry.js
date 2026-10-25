// LLM Proxy admin UI -- ES module entry point of the browser bundle.
// This file is the root the bundler walks: every capability below arrives through an
// import, so the bundle has no undeclared names of its own.

import { createProxyConfig } from "./modules/proxy-config.js";
import { createLoadBalancing } from "./modules/load-balancing.js";
import { configureDisplayLanguage } from "./modules/display-locale.js";
import { chartMeanLine, chartPeakLabel, costAxisLabel, niceAxisScale } from "./modules/chart.js";
import {
  compactNumber,
  formatIntegerValue,
  formatTokenCount,
  formatTokensPerSecond,
  fullNumber,
  optionalFiniteNumber,
  positiveNumber,
  pricingDecimalFromNano,
} from "./modules/numbers.js";
import { escapeHtml, formatString } from "./modules/text.js";
import { displayTimestampParts, formatDuration } from "./modules/time.js";

/**
 * TRANSITION BRIDGE (AI-17) — remove this whole block before AI-19 finishes.
 *
 * The nine numbered files are still classic scripts that share one script scope, so
 * they cannot import. This block is the only channel between the module graph and
 * those files, and the assignments below are the entire contract: no other module
 * name reaches the browser scope. A `globalThis` assignment is also how the type
 * checker learns the name, so a call site that misspells one of these is a real
 * diagnostic instead of an undefined property at runtime.
 *
 * When a numbered file is migrated it imports the module directly and drops its line
 * here; AI-19 removes the last one together with the numbered-script load order.
 * `test-node/admin/static-bridge.test.ts` pins this list against the module exports
 * and against the globals ESLint is told about.
 */
/** The only writer of the display locale; see `applyLanguage()` in `01-core.js`. */
globalThis.configureDisplayLanguage = configureDisplayLanguage;
globalThis.escapeHtml = escapeHtml;
globalThis.formatString = formatString;
globalThis.displayTimestampParts = displayTimestampParts;
globalThis.formatDuration = formatDuration;
globalThis.optionalFiniteNumber = optionalFiniteNumber;
globalThis.positiveNumber = positiveNumber;
globalThis.compactNumber = compactNumber;
globalThis.fullNumber = fullNumber;
globalThis.formatIntegerValue = formatIntegerValue;
globalThis.formatTokenCount = formatTokenCount;
globalThis.pricingDecimalFromNano = pricingDecimalFromNano;
globalThis.formatTokensPerSecond = formatTokensPerSecond;
globalThis.niceAxisScale = niceAxisScale;
globalThis.chartMeanLine = chartMeanLine;
globalThis.chartPeakLabel = chartPeakLabel;
globalThis.costAxisLabel = costAxisLabel;

globalThis.createProxyConfig = createProxyConfig;
globalThis.createLoadBalancing = createLoadBalancing;
