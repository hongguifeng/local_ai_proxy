// LLM Proxy admin UI -- JSON tree pane: lazy materialization, line-width probes, row windowing,
// metadata pane and the pane toolbar it drives.
// ES module: imports the shared bootstrap (./core.js) and the display helpers; the history
// list calls its render operations, and it never reaches into another feature's scope.

import {
  $,
  asElement,
  closestFrom,
  closestOn,
  qs,
  qsa,
  qsaOn,
  qsOn,
  registerLanguagePanel,
  state,
  t,
  toast,
} from "./core.js";
import { formatTokensPerSecond, positiveNumber } from "./numbers.js";
import { escapeHtml, formatString } from "./text.js";
import { formatDuration } from "./time.js";

// Redraw on language change. The sequence mirrors the order the switch used to
// call these in by hand; see registerLanguagePanel in ./core.js.
registerLanguagePanel("jsonPanes", 30, () => {
  renderJsonPane("request", { preserveView: true });
  renderJsonPane("response", { preserveView: true });
  applyPaneChrome();
});

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
const defaultJsonExpandedDepth = 2;
// Trees with more entries than this render lazily: a node that starts collapsed
// keeps only its summary in the DOM and fills its children when the user opens
// it. Assigning a fully built multi-megabyte tree blocks the main thread for
// seconds, and an automatic refresh re-assigns it while a request is in flight.
const lazyJsonEntryLimit = 1500;
function jsonEntryCount(value, limit) {
  let count = 0;
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    const entries = Array.isArray(current) ? current : Object.values(current);
    for (const entry of entries) stack.push(entry);
    count += entries.length;
    if (count > limit) return count;
  }
  return count;
}
function resolveJsonPathValue(raw, path) {
  let current = raw;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object") {
      current = current[key];
      continue;
    }
    return undefined;
  }
  return current;
}
// Rows skip layout while offscreen, but Chromium realizes a newly visible row
// only one frame *after* it paints, which shows as a blank flash during fast
// scrolling. A frame watcher pre-realizes the rows around the viewport: the
// requestAnimationFrame callback runs before the frame's style/layout/paint,
// so rows are filled by the time they appear - for wheel and programmatic
// scrolls alike. Style writes stay batched after the reads to avoid interleaved
// recalculations. A fling lands hundreds of rows away from where the walker last
// stopped, so a jump bigger than the viewport re-anchors by sampling the row
// list in bulk instead of walking to the landing point one row at a time.
const jsonRowWindow = {};
function jsonRowWindowInvalidate(key) {
  const cached = jsonRowWindow[key];
  if (cached) cached.valid = false;
}
// The cached row list is in document order, which for this tree is also
// top-to-bottom order, so the walker moves by index instead of following DOM
// neighbours: rows inside a collapsed node have a zero rect, and neighbour
// walking skipped or lost whole subtrees, leaving blank rows behind a fast scroll.
const jsonRowStepPerViewport = 18;
function updateJsonRowWindow(key) {
  const el = $(key + "Json");
  let windowState = jsonRowWindow[key];
  if (!windowState || !windowState.valid) {
    windowState = jsonRowWindow[key] = {
      rows: qsaOn(el, ".json-row"),
      hint: 0,
      top: -1,
      valid: true,
    };
  }
  const rows = windowState.rows;
  if (!rows.length) return;
  // The hint may point past a row list that shrank when the pane rebuilt.
  const hint = Math.min(windowState.hint, rows.length - 1);
  const rect = el.getBoundingClientRect();
  const contentTop = el.scrollTop;
  const lookaheadBottom = contentTop + rect.height * 2.2;
  const revertTop = contentTop - rect.height * 3;
  const jump = Math.abs(contentTop - windowState.top);
  // Rects are in viewport coordinates while the zones are in scroll content
  // coordinates, so the pane offset is added back before every comparison.
  const contentRowTop = (box) => box.top - rect.top + contentTop;
  const realize = (box) => {
    const top = contentRowTop(box);
    return top + box.height > revertTop && top < lookaheadBottom ? "visible" : "auto";
  };
  // A fling lands hundreds of rows away from where the walker last stopped, so
  // neither the walk back from the hint nor the walk down from it reaches the
  // rows the user scrolled to. The flat list is stepped in bulk instead: rows
  // inside a closed node report a zero rect and would each cost a step.
  const restart = jump > rect.height * 2;
  let anchor = hint;
  if (restart) {
    const stride = 8;
    anchor = 0;
    for (let index = 0; index < rows.length; index += stride) {
      anchor = index;
      if (contentRowTop(rows[index].getBoundingClientRect()) >= contentTop) break;
    }
  }
  // Rows just above the landing row are partly scrolled past and still paint, so
  // they are realized as well. A normal wheel step only moves a few rows, so the
  // walk back from the hint is enough and its budget grows with the distance.
  const warm = [];
  let firstVisible = undefined;
  const warmBudget = restart ? 24 : 24 + Math.ceil(jump / jsonRowStepPerViewport);
  for (let index = anchor - 1; index >= 0 && warm.length < warmBudget; index--) {
    const row = rows[index];
    const box = row.getBoundingClientRect();
    warm.push([row, box]);
    // The first row that has any part inside the scrollport, scanning from the
    // top down: the next walk starts here instead of at the old stop position.
    if (contentRowTop(box) + box.height > contentTop) firstVisible = index;
    if (contentRowTop(box) + box.height <= revertTop) break;
  }
  // Rows from the anchor down in document order. The walk stops at the first row
  // below the lookahead zone; the next scroll event continues from there. Rows
  // inside a closed node have a zero rect and never end the walk, so the step
  // count is bounded and a later scroll simply continues from where it stopped.
  const below = [];
  let index = anchor;
  while (index < rows.length && below.length < 600) {
    const row = rows[index];
    const box = row.getBoundingClientRect();
    below.push([row, box]);
    index++;
    if (contentRowTop(box) >= lookaheadBottom) break;
  }
  // One batch of writes after all the reads: realize everything from the
  // revert zone through the lookahead, skip what lies beyond.
  for (const [row, box] of warm) row.style.contentVisibility = realize(box);
  for (const [row, box] of below) row.style.contentVisibility = realize(box);
  windowState.hint = firstVisible === undefined ? index : firstVisible;
  windowState.top = contentTop;
}
/**
 * Attaches every listener the panes own: the scroll-driven row window, the
 * wrap/meta/expand/format/copy toolbar buttons, the lazy `toggle` materialization and the
 * string-copy clicks. Nothing here runs at import time, so the page decides when the panes
 * become interactive and a test can mount them in any order.
 * @returns {void}
 */
export function mountJsonPanes() {
  ["request", "response"].forEach((key) => {
    // Wake on scroll events and update in the next frame's rAF, which runs
    // before that frame's paint, so rows are realized by the time they show.
    // The check re-arms only while the scroll position keeps moving: an
    // always-running rAF loop would never settle under faked clocks (tests use
    // page.clock) and wastes frames when idle.
    let lastTop = -1;
    let pending = false;
    const checkJsonRows = () => {
      pending = false;
      const el = $(key + "Json");
      const top = el.scrollTop;
      if (top === lastTop) return;
      lastTop = top;
      updateJsonRowWindow(key);
      pending = true;
      requestAnimationFrame(checkJsonRows);
    };
    $(key + "Json").addEventListener("scroll", () => {
      if (!pending) {
        pending = true;
        requestAnimationFrame(checkJsonRows);
      }
    });

    // Keep the cached line width current so lazy fills never read clientWidth
    // after a mutation (that read forces a synchronous re-layout of the pane).
    new ResizeObserver(() => {
      const el = $(key + "Json");
      jsonLineWidthCache[key] = el.clientWidth > 24 ? el.clientWidth - 24 : 0;
    }).observe($(key + "Json"));
    $(key + "Json").addEventListener(
      "toggle",
      (event) => {
        const detail = asElement(event.target);
        if (detail instanceof HTMLElement && detail.open && detail.dataset.jsonLazy === "1") {
          enqueueJsonMaterialize($(key + "Json"), detail);
        }
        schedulePaneButtonsUpdate(key);
      },
      true,
    );
    $(key + "Json").addEventListener("click", (event) => {
      const summary = closestFrom(event.target, "summary");
      const detail =
        summary && summary.parentElement.matches("details.json-node")
          ? summary.parentElement
          : null;
      if (detail) {
        const container = $(key + "Json");
        const naturalTop = jsonContentOffset(container, detail);
        const visualTop =
          summary.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop;
        const stuckBy = visualTop - naturalTop;
        if (stuckBy > 0.5) {
          event.preventDefault();
          container.scrollTo({
            top: Math.max(0, container.scrollTop - stuckBy),
            behavior: "smooth",
          });
        }
      }
      const button = closestFrom(event.target, "[data-copy-string]");
      if (!button) return;
      const body = button.closest(".json-str-full")?.querySelector(".json-str-body");
      if (!body) return;
      navigator.clipboard.writeText(body.textContent || "").then(
        () => toast(t("copiedText")),
        () => toast(t("copyFailed")),
      );
    });
  });
  qsa("[data-wrap]").forEach((button) =>
    button.addEventListener("click", () => {
      const key = button.dataset.wrap;
      state.wrap[key] = !state.wrap[key];
      renderJsonPane(key, { preserveView: true });
    }),
  );
  qsa("[data-meta]").forEach((button) =>
    button.addEventListener("click", () => {
      const key = button.dataset.meta;
      if (!key || !hasMetadata(state.meta[key])) return;
      state.metaOpen[key] = !state.metaOpen[key];
      renderMetaPane(key);
    }),
  );
  qsa("[data-expand]").forEach((button) =>
    button.addEventListener("click", () => {
      const key = button.dataset.expand;
      state.tree[key] = true;
      if (qsaOn($(key + "Json"), "details").length === 0) renderJsonPane(key);
      const details = qsaOn($(key + "Json"), "details:not(.json-str-detail)");
      const allOpen = details.length > 0 && details.every((detail) => detail.open);
      if (allOpen) {
        details.forEach((detail) => {
          const parentDetail = detail.parentElement
            ? detail.parentElement.closest("details")
            : null;
          detail.open =
            detail.classList.contains("root") || Boolean(parentDetail?.classList.contains("root"));
        });
      } else {
        const nextLevel = details.filter((detail) => {
          if (detail.open) return false;
          let parentDetail = detail.parentElement ? detail.parentElement.closest("details") : null;
          while (parentDetail) {
            if (!parentDetail.open) return false;
            parentDetail = parentDetail.parentElement
              ? parentDetail.parentElement.closest("details")
              : null;
          }
          return true;
        });
        // Refresh the width cache before touching the tree, then queue instead
        // of opening here: the click returns immediately and the queue opens
        // each node right after its children are filled, so the level streams
        // in without blocking the main thread.
        jsonLineWidthCache[key] =
          $(key + "Json").clientWidth > 24 ? $(key + "Json").clientWidth - 24 : 0;
        nextLevel.forEach((detail) => {
          // Non-lazy trees already have their children in the DOM, so opening
          // directly is the correct (and cheap) path; only lazy nodes go
          // through the queue, which fills them before opening.
          if (detail.dataset.jsonLazy === "1") enqueueJsonMaterialize($(key + "Json"), detail);
          else detail.open = true;
        });
        schedulePaneButtonsUpdate(key);
      }
    }),
  );
  qsa("[data-format]").forEach((button) =>
    button.addEventListener("click", () => {
      const key = button.dataset.format;
      state.formatStrings[key] = !state.formatStrings[key];
      renderJsonPane(key, { preserveView: true });
    }),
  );
  qsa("[data-copy]").forEach((button) =>
    button.addEventListener("click", () => {
      const key = button.dataset.copy;
      if (key && state.raw[key] !== null) {
        navigator.clipboard.writeText(JSON.stringify(state.raw[key], null, 2)).then(
          () => toast(t("copiedJson")),
          () => toast(t("copyFailed")),
        );
      }
    }),
  );
}

/**
 * Re-applies the toolbar text and the response timing line. Both read `t()` rather than a
 * `data-i18n` attribute, so the dictionary pass cannot reach them, and both live in this
 * module so the pane's chrome has a single owner.
 * @returns {void}
 */
export function applyPaneChrome() {
  updateExpandButton("request");
  updateExpandButton("response");
  updateMetaButton("request");
  updateMetaButton("response");
  updateResponseTiming();
}
/** Fills the children of a node that the lazy first render left empty. */
function materializeJsonNode(el, detail) {
  if (detail.dataset.jsonLazy !== "1" || detail.dataset.jsonLazyDone === "1") return;
  const key = el.dataset.jsonPaneKey;
  const raw = key === "response" ? state.raw.response : state.raw.request;
  const path = JSON.parse(detail.dataset.jsonNodePath || "[]");
  const value = resolveJsonPathValue(raw, path);
  const depth = Number(detail.dataset.jsonDepth) || 0;
  // The cached width keeps this off the layout: reading clientWidth after the
  // tree was mutated forces a synchronous re-layout of the whole pane.
  const lineWidth = jsonLineWidthCache[key] || 0;
  // The strings this node is about to render need line-width probes; measuring
  // the whole subtree in one batch keeps the fill off the per-string fallback,
  // which would force a layout for every string in it.
  if (state.formatStrings[key] && lineWidth > 0) {
    prepareJsonMeasurements(value, lineWidth, Infinity, String(path[path.length - 1] ?? ""), depth);
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value || {});
  const openCount = Number(detail.dataset.jsonDepth) || 0;
  const html = entries
    .map(([childKey, childValue]) =>
      jsonRowHtml(
        childValue,
        String(childKey),
        state.formatStrings[key],
        depth + 1,
        path.concat([childKey]),
        lineWidth,
        true,
        openCount,
        false,
      ),
    )
    .join("");
  const children = qsOn(detail, ":scope > .json-children");
  if (children) children.innerHTML = html;
  else detail.insertAdjacentHTML("beforeend", `<div class="json-children">${html}</div>`);
  detail.dataset.jsonLazyDone = "1";
  jsonRowWindowInvalidate(key);
  // The parent row rendered as a single collapsed line until now; refresh its
  // size hint so the scrollbar accounts for the children that were just added.
  const parentRow = closestOn(children?.parentElement, ".json-row");
  if (parentRow && !parentRow.classList.contains("json-pane-root")) {
    const filledLines = jsonLineCount(
      value,
      state.formatStrings[key],
      lineWidth,
      openCount,
      state.wrap[key] === true,
    );
    parentRow.style.containIntrinsicSize = `auto ${filledLines * 18}px`;
  }
}
// Materializing every node of a freshly opened level in one synchronous pass
// blocks the main thread for hundreds of milliseconds on multi-megabyte bodies,
// so the click feels dead. Queued nodes are filled in time-budgeted batches:
// the click returns after only queueing, each node gets its children before it
// opens so it never paints empty, and the event loop stays free between
// batches for painting and other work. Nodes a pane rebuild detached are
// skipped.
const jsonMaterializeQueue = [];
const jsonMaterializeBudgetMs = 12;
let jsonMaterializeRunning = false;
function enqueueJsonMaterialize(el, detail) {
  if (detail.dataset.jsonLazy !== "1" || detail.dataset.jsonLazyDone === "1") return;
  jsonMaterializeQueue.push({ el, detail });
  // Kick from a task, never synchronously: the click handler must return
  // first so the browser can paint, and each batch's layout lands on a frame
  // boundary instead of blocking the click.
  if (!jsonMaterializeRunning) setTimeout(drainJsonMaterializeQueue, 0);
}
function drainJsonMaterializeQueue() {
  if (jsonMaterializeRunning) return;
  jsonMaterializeRunning = true;
  const start = performance.now();
  while (jsonMaterializeQueue.length) {
    const item = jsonMaterializeQueue.shift();
    if (!item.detail.isConnected) continue;
    // Fill first, open second: the node appears already populated, and the
    // browser never lays out a level twice (empty, then filled).
    materializeJsonNode(item.el, item.detail);
    item.detail.open = true;
    if (performance.now() - start >= jsonMaterializeBudgetMs) break;
  }
  jsonMaterializeRunning = false;
  if (jsonMaterializeQueue.length) setTimeout(drainJsonMaterializeQueue, 0);
}
// Opening a batch of lazy nodes fires one toggle event per node; updating the
// pane buttons on every event re-scans the whole tree hundreds of times. One
// coalesced task per burst keeps the buttons current at negligible cost - a
// timeout (not a microtask) so bursts that span several queue batches still
// collapse into a single update.
let jsonPaneButtonsUpdateQueued = false;
const jsonPaneButtonsUpdateKeys = new Set();
function jsonContentOffset(container, el) {
  let top = 0;
  let node = el;
  while (node && node !== container) {
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return top;
}
function jsonNodePathAttr(path) {
  return escapeHtml(JSON.stringify(path));
}
function collectJsonPaneViewState(el) {
  const nodeState = new Map();
  qsaOn(el, "details[data-json-node-path]").forEach((detail) => {
    const body = detail.classList.contains("json-str-detail")
      ? qsOn(detail, ".json-str-body")
      : null;
    nodeState.set(detail.dataset.jsonNodePath, {
      open: detail.open,
      scrollTop: body?.scrollTop || 0,
      scrollLeft: body?.scrollLeft || 0,
    });
  });
  return { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, nodeState };
}
function restoreJsonPaneViewState(el, viewState) {
  if (!viewState) return;
  qsaOn(el, "details[data-json-node-path]").forEach((detail) => {
    const saved = viewState.nodeState.get(detail.dataset.jsonNodePath);
    if (!saved) return;
    detail.open = saved.open;
    if (detail.open && detail.dataset.jsonLazy === "1") enqueueJsonMaterialize(el, detail);
    if (!detail.classList.contains("json-str-detail")) return;
    const body = qsOn(detail, ".json-str-body");
    if (!body) return;
    body.scrollTop = saved.scrollTop;
    body.scrollLeft = saved.scrollLeft;
  });
  el.scrollTop = viewState.scrollTop;
  el.scrollLeft = viewState.scrollLeft;
}
// Rows skip layout and paint while offscreen (content-visibility in app.css),
// so the browser needs a size hint for rows it has never realized. The hint
// counts the lines the subtree renders *in its current open state*: collapsed
// nodes and collapsed strings count as the single summary line they show.
const jsonLineCache = new WeakMap();
function jsonLineCount(value, formatMode, lineWidth, openCount, wrap) {
  if (value === null || typeof value !== "object") {
    // WeakMap only accepts objects, so primitives are never cached; counting
    // them is trivial anyway.
    return countJsonLinesWalk(value, formatMode, lineWidth, 0, false, wrap);
  }
  const cache = jsonLineCache.get(value);
  if (cache) {
    const hit = cache.get(`${formatMode ? 1 : 0}:${lineWidth}:${openCount}:${wrap ? 1 : 0}`);
    if (hit !== undefined) return hit;
    const lines = countJsonLinesWalk(value, formatMode, lineWidth, 0, true, wrap);
    cache.set(`${formatMode ? 1 : 0}:${lineWidth}:${openCount}:${wrap ? 1 : 0}`, lines);
    return lines;
  }
  const lines = countJsonLinesWalk(value, formatMode, lineWidth, 0, true, wrap);
  jsonLineCache.set(value, new Map());
  jsonLineCache
    .get(value)
    .set(`${formatMode ? 1 : 0}:${lineWidth}:${openCount}:${wrap ? 1 : 0}`, lines);
  return lines;
}
function countJsonLinesWalk(value, formatMode, lineWidth, depth, open, wrap) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      if (!formatMode) return 1;
      const display = formatString(value);
      const newlines = display.split(String.fromCharCode(10)).length;
      if (newlines > 1) return display.length > 150 ? 1 : newlines;
      if (lineWidth > 0 && !jsonTextFitsOnLine(display, "", depth, lineWidth)) {
        return display.length > 150 ? 1 : Math.ceil(display.length / Math.max(lineWidth, 1));
      }
      if (wrap && lineWidth > 0 && display.length > lineWidth) {
        return Math.ceil(display.length / Math.max(lineWidth, 1));
      }
      return 1;
    }
    return 1;
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value);
  const nodeOpen = depth < defaultJsonExpandedDepth || open;
  if (!nodeOpen) return 1;
  let lines = 2;
  for (const [, child] of entries)
    lines += countJsonLinesWalk(child, formatMode, lineWidth, depth + 1, open, wrap);
  return lines;
}
function jsonRowHtml(value, key, formatMode, depth, path, lineWidth, lazy, openCount, isRoot) {
  const content = renderJsonValue(
    value,
    key,
    isRoot,
    formatMode,
    depth,
    path,
    lineWidth,
    lazy,
    openCount,
  );
  if (isRoot) return `<div class="json-row">${content}</div>`;
  const lines = jsonLineCount(value, formatMode, lineWidth, openCount, state.wrap[key] === true);
  return `<div class="json-row" style="contain-intrinsic-size: auto ${lines * 18}px">${content}</div>`;
}
function renderJsonValue(
  value,
  key = "",
  root = false,
  formatMode = false,
  depth = 0,
  path = [],
  lineWidth = 0,
  lazy = false,
  openCount = defaultJsonExpandedDepth,
) {
  const type = jsonType(value);
  const keyHtml =
    key === "" ? "" : `<span class="json-key">${escapeHtml(JSON.stringify(key))}</span>: `;
  if (type === "array" || type === "object") {
    const entries =
      type === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
    const start = type === "array" ? "[" : "{";
    const end = type === "array" ? "]" : "}";
    const summary = `${keyHtml}${start}<span class="json-muted">${entries.length ? ` ${entries.length} ${t("items")} ` : ""}</span>${end}`;
    // A node that starts collapsed in a lazy tree renders its children only
    // when the user opens it, so the first paint pays for the visible levels.
    const open = depth < defaultJsonExpandedDepth;
    const childrenHtml =
      lazy && !open
        ? `<div class="json-children"></div>`
        : `<div class="json-children">${entries
            .map(([childKey, childValue]) =>
              jsonRowHtml(
                childValue,
                String(childKey),
                formatMode,
                depth + 1,
                path.concat([childKey]),
                lineWidth,
                lazy,
                openCount,
                false,
              ),
            )
            .join("")}</div>`;
    const openAttr = open ? " open" : "";
    const lazyAttr = lazy && !open ? ' data-json-lazy="1"' : "";
    return `<details${openAttr} class="json-node${root ? " root" : ""}" data-json-depth="${depth}" style="--json-sticky-depth: ${depth}" data-json-node-path="${jsonNodePathAttr(path)}"${lazyAttr}><summary>${summary}</summary>${childrenHtml}<div class="json-muted">${end}</div></details>`;
  }
  if (type === "string") {
    const plain = `${keyHtml}<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
    if (!formatMode) return plain;
    const displayValue = formatString(value);
    const hasNewline = displayValue.indexOf(String.fromCharCode(10)) !== -1;
    const shouldFormat = hasNewline || value.indexOf("\\") !== -1 || value.indexOf('"') !== -1;
    const tooWide =
      !hasNewline && lineWidth > 0 && !jsonTextFitsOnLine(displayValue, key, depth, lineWidth);
    if (hasNewline || tooWide) {
      const summaryRaw = displayValue.substring(0, 150);
      const summarySingleLine = escapeHtml(summaryRaw.replace(/\r\n/g, "↵").replace(/\n/g, "↵"));
      const summaryText = summarySingleLine + (displayValue.length > 150 ? "…" : "");
      const fullLines = displayValue.split(String.fromCharCode(10)).length;
      return `${keyHtml}<details class="json-str-detail" data-json-node-path="${jsonNodePathAttr(path)}"><summary>${summaryText} <span class="json-muted">(${fullLines} ${t("lines")})</span></summary><div class="json-str-full"><button class="json-str-copy" data-copy-string title="${escapeHtml(t("copyFormattedText"))}">📋</button><pre class="json-str-body">${escapeHtml(displayValue)}</pre></div></details>`;
    }
    if (!shouldFormat) return plain;
    return `${keyHtml}<span class="json-string format-mode">${escapeHtml(displayValue)}</span>`;
  }
  if (type === "number")
    return `${keyHtml}<span class="json-number">${escapeHtml(String(value))}</span>`;
  if (type === "boolean")
    return `${keyHtml}<span class="json-boolean">${escapeHtml(String(value))}</span>`;
  if (type === "undefined") return `${keyHtml}<span class="json-null">undefined</span>`;
  return `${keyHtml}<span class="json-null">null</span>`;
}
let jsonMeasureBox = null;
let jsonMeasureResults = new Map();
function ensureJsonMeasureBox() {
  if (!jsonMeasureBox) {
    jsonMeasureBox = document.createElement("div");
    jsonMeasureBox.style.cssText =
      "position:absolute;top:0;left:-9999px;visibility:hidden;white-space:pre;padding:0;margin:0;border:0;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;";
    document.body.appendChild(jsonMeasureBox);
  }
  return jsonMeasureBox;
}
function collectJsonMeasureProbes(value, key, depth, lineWidth, probes, maxDepth = Infinity) {
  if (value === null || value === undefined) return;
  const type = jsonType(value);
  if (type === "array" || type === "object") {
    // Everything below the rendered depth sits behind a lazy node, so its
    // strings are only summarized here and get measured when it is filled.
    if (depth >= maxDepth) return;
    const entries =
      type === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
    for (const [childKey, childValue] of entries) {
      collectJsonMeasureProbes(
        childValue,
        String(childKey),
        depth + 1,
        lineWidth,
        probes,
        maxDepth,
      );
    }
    return;
  }
  if (type !== "string") return;
  const displayValue = formatString(value);
  if (displayValue.indexOf(String.fromCharCode(10)) !== -1) return;
  const probe = (key === "" ? "" : JSON.stringify(key) + ": ") + displayValue;
  const available = lineWidth - 16 * depth - 8;
  if (available > 0 && probe.length * 12 > available && probe.length * 7.2 <= available) {
    probes.push(probe);
  }
}
let jsonMeasureWidth = -1;
function prepareJsonMeasurements(value, lineWidth, maxDepth = Infinity, key = "", depth = 0) {
  // Widths are only valid for the pane width they were taken at, so a resize
  // invalidates the whole measurement cache; the size cap keeps a long session
  // over many huge bodies from growing the probe keys without bound.
  if (jsonMeasureWidth !== lineWidth || jsonMeasureResults.size > 20_000) {
    jsonMeasureWidth = lineWidth;
    jsonMeasureResults = new Map();
  }
  if (lineWidth <= 0) return;
  const probes = [];
  collectJsonMeasureProbes(value, key, depth, lineWidth, probes, maxDepth);
  if (!probes.length) return;
  const box = ensureJsonMeasureBox();
  box.textContent = "";
  const measured = [];
  const seen = new Set();
  for (const probe of probes) {
    if (seen.has(probe)) continue;
    seen.add(probe);
    const el = document.createElement("div");
    el.textContent = probe;
    box.appendChild(el);
    measured.push([probe, el]);
  }
  // 一次性强制布局，批量拿到全部探测文本的宽度
  void box.offsetHeight;
  for (const [probe, el] of measured) jsonMeasureResults.set(probe, el.offsetWidth);
}
function measureJsonTextWidth(text) {
  const cached = jsonMeasureResults.get(text);
  if (cached !== undefined) return cached;
  // 回退：预扫描未覆盖时单独测量
  const box = ensureJsonMeasureBox();
  box.textContent = text;
  return box.offsetWidth;
}
function jsonTextFitsOnLine(displayValue, key, depth, lineWidth) {
  const probe = (key === "" ? "" : JSON.stringify(key) + ": ") + displayValue;
  const available = lineWidth - 16 * depth - 8;
  if (available <= 0) return false;
  if (probe.length * 12 <= available) return true;
  if (probe.length * 7.2 > available) return false;
  return measureJsonTextWidth(probe) <= available;
}
function jsonText(value) {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? "undefined" : text;
}
const jsonLineWidthCache = {};
export function renderJsonPane(key, options = {}) {
  const el = $(key + "Json");
  // Cache the content width while the DOM is still clean: reading it later,
  // after the tree was mutated, forces a synchronous re-layout.
  jsonLineWidthCache[key] = el.clientWidth > 24 ? el.clientWidth - 24 : 0;
  const viewState = options.preserveView ? collectJsonPaneViewState(el) : null;
  el.classList.toggle("wrap", state.wrap[key]);
  el.classList.toggle("nowrap", !state.wrap[key]);
  const rendered = state.jsonPaneHtml[key];
  // Parsing the tree is what costs: a several-hundred-kilobyte request body is
  // tens of thousands of nodes. Building the markup is cheap, so a refresh that
  // produced the same markup keeps the existing DOM instead of re-parsing it.
  if (state.tree[key]) {
    el.dataset.jsonPaneKey = key;
    const lineWidth = el.clientWidth > 24 ? el.clientWidth - 24 : 0;
    if (state.formatStrings[key])
      prepareJsonMeasurements(state.raw[key], lineWidth, defaultJsonExpandedDepth);
    const html = jsonRowHtml(
      state.raw[key],
      "",
      state.formatStrings[key],
      0,
      [],
      lineWidth,
      jsonEntryCount(state.raw[key], lazyJsonEntryLimit) > lazyJsonEntryLimit,
      defaultJsonExpandedDepth,
      true,
    );
    if (html !== rendered) {
      state.jsonPaneHtml[key] = html;
      el.innerHTML = html;
      jsonRowWindowInvalidate(key);
      restoreJsonPaneViewState(el, viewState);
    }
  } else {
    const text = jsonText(state.raw[key]);
    if (text !== rendered) {
      state.jsonPaneHtml[key] = text;
      el.textContent = text;
      jsonRowWindowInvalidate(key);
    }
  }
  updateExpandButton(key);
  updatePaneButtons(key);
}

function hasMetadata(value) {
  return Boolean(value && typeof value === "object" && Object.keys(value).length);
}
export function renderMetaPane(key) {
  const el = $(key + "Meta");
  const available = hasMetadata(state.meta[key]);
  const open = available && state.metaOpen[key];
  el.hidden = !open;
  el.innerHTML = open ? renderJsonValue(state.meta[key], "", true, true, 0) : "";
  updateMetaButton(key);
}
export function updateResponseTiming() {
  const element = $("responseTiming");
  const meta = state.meta.response || {};
  const firstToken = formatDuration(meta.first_token_ms);
  const total = formatDuration(meta.duration_ms);
  const parts = [
    ...(firstToken === "" ? [] : [`${t("firstTokenTime")} ${firstToken}`]),
    ...(total === "" ? [] : [`${t("totalTime")} ${total}`]),
  ];
  const tokenMs = positiveNumber(meta.first_token_ms);
  const durationMs = positiveNumber(meta.duration_ms);
  const measured = tokenMs !== undefined;
  // New records provide an explicit generated-content window. Zero means
  // buffered/non-streaming output: use end-to-end speed, never invent decode.
  // Legacy records retain their historical timing convention.
  const windowMs =
    meta.decode_window_ms !== undefined && meta.decode_window_ms !== null
      ? positiveNumber(meta.decode_window_ms)
      : measured
        ? durationMs - tokenMs
        : undefined;
  if (durationMs !== undefined) {
    const inputTokens = positiveNumber(meta.request_token_count) ?? 0;
    const cachedTokens = Math.min(positiveNumber(meta.cached_token_count) ?? 0, inputTokens);
    const prefill =
      measured && (meta.decode_window_ms == null || windowMs !== undefined)
        ? formatTokensPerSecond((inputTokens - cachedTokens) * (1000 / tokenMs))
        : "";
    const decode =
      windowMs !== undefined && windowMs >= 1
        ? formatTokensPerSecond(
            (positiveNumber(meta.response_token_count) ?? 0) * (1000 / windowMs),
          )
        : "";
    if (prefill !== "") parts.push(`${t("prefillSpeed")} ${prefill} ${t("tokensPerSecond")}`);
    if (decode === "") {
      const speed = formatTokensPerSecond(
        ((positiveNumber(meta.response_token_count) ?? 0) * 1000) / durationMs,
      );
      if (speed !== "") parts.push(`${t("endToEndSpeed")} ${speed} ${t("tokensPerSecond")}`);
    }
    if (decode !== "") parts.push(`${t("decodeSpeed")} ${decode} ${t("tokensPerSecond")}`);
  }
  element.textContent = parts.join(" · ");
  element.hidden = parts.length === 0;
}
function updateMetaButton(key) {
  const button = qs(`[data-meta="${key}"]`);
  if (!button) return;
  const available = hasMetadata(state.meta[key]);
  button.disabled = !available;
  button.classList.toggle("active", available && state.metaOpen[key]);
  button.title = available && state.metaOpen[key] ? t("hideMetadata") : t("showMetadata");
}
function updatePaneButtons(key) {
  qs(`[data-wrap="${key}"]`).classList.toggle("active", state.wrap[key]);
  qs(`[data-format="${key}"]`).classList.toggle("active", state.formatStrings[key]);
  const expandBtn = qs(`[data-expand="${key}"]`);
  if (expandBtn) {
    const details = qsaOn($(key + "Json"), "details:not(.json-str-detail)");
    const allOpen = details.length > 0 && details.every((detail) => detail.open);
    expandBtn.classList.toggle("active", !allOpen);
  }
}
function updateExpandButton(key) {
  const button = qs(`[data-expand="${key}"]`);
  if (!button) return;
  const details = qsaOn($(key + "Json"), "details:not(.json-str-detail)");
  const allOpen = details.length > 0 && details.every((detail) => detail.open);
  button.title = allOpen ? t("collapseJson") : t("expandJson");
}

function schedulePaneButtonsUpdate(key) {
  jsonPaneButtonsUpdateKeys.add(key);
  if (jsonPaneButtonsUpdateQueued) return;
  jsonPaneButtonsUpdateQueued = true;
  setTimeout(() => {
    jsonPaneButtonsUpdateQueued = false;
    for (const pendingKey of jsonPaneButtonsUpdateKeys) {
      updateExpandButton(pendingKey);
      updatePaneButtons(pendingKey);
    }
    jsonPaneButtonsUpdateKeys.clear();
  });
}
