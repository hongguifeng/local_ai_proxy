import { detailsOn, optionalTyped, requiredTyped } from "./dom.js";
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
/** The `[key, child]` pairs a node renders, in the order the pane shows them. */
function jsonChildEntries(value) {
  return Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value === null ? {} : value || {});
}
/** The child key as the pane renders and indexes it. */
function jsonChildKey(key) {
  return String(key);
}
/** The node path of `childKey` inside `path`. */
function childNodePath(path, childKey) {
  return path.concat([childKey]);
}
/**
 * What a container's summary line depends on: its bracket type and how many children it
 * has. A refresh that changes only descendants keeps this equal, so an open node's summary
 * keeps its DOM instead of being rewritten on the way down to the value that changed.
 * @param {unknown} value
 * @returns {string | null}
 */
function jsonSummarySignature(value) {
  if (value === null || typeof value !== "object") return null;
  return Array.isArray(value) ? `[${value.length}` : `{${Object.keys(value).length}`;
}
/**
 * The brackets a container's summary shows. Two values with the same brackets share the key
 * prefix and the bracket text of the summary line, so only the child count inside it can
 * differ and only that text node has to change.
 * @param {unknown} value
 * @returns {string}
 */
function jsonSummaryShape(value) {
  if (value === null || typeof value !== "object") return "";
  return Array.isArray(value) ? "[" : "{";
}
/**
 * Structural identity of two raw JSON values.
 *
 * The pane rebuilds only the nodes this reports as different, so an unchanged subtree
 * keeps its DOM and its already-materialized children. Numbers compare with `===`, which
 * folds `-0` into `0` exactly as `JSON.stringify` does; `NaN` is folded by `Object.is`,
 * which is what the serialized text shows as well.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left !== left && right !== right) return true;
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  // The pane shows object keys in the order they arrived, so key order is part of what counts
  // as the same value: keys that swapped places are a change the rows have to move for.
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index];
    if (rightKeys[index] !== key || !Object.hasOwn(right, key)) return false;
    if (!sameJsonValue(left[key], right[key])) return false;
  }
  return true;
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
        if (
          detail instanceof HTMLDetailsElement &&
          detail.open &&
          detail.dataset.jsonLazy === "1"
        ) {
          enqueueJsonMaterialize($(key + "Json"), detail);
        }
        schedulePaneButtonsUpdate(key);
      },
      true,
    );
    $(key + "Json").addEventListener("click", (event) => {
      const summary = closestFrom(event.target, "summary");
      const detail =
        summary?.parentElement && summary.parentElement.matches("details.json-node")
          ? summary.parentElement
          : null;
      if (detail && summary) {
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
      if (!key) throw new Error("Missing pane data attribute");
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
      if (!key) throw new Error("Missing pane data attribute");
      state.tree[key] = true;
      if (detailsOn($(key + "Json"), "details").length === 0) renderJsonPane(key);
      const details = detailsOn($(key + "Json"), "details:not(.json-str-detail)");
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
      if (!key) throw new Error("Missing pane data attribute");
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
/** Fills a lazy node in bounded child-row chunks. */
const jsonMaterializeStates = new WeakMap();
const jsonMaterializeChunkSize = 96;
function materializeJsonNode(el, detail) {
  if (detail.dataset.jsonLazy !== "1" || detail.dataset.jsonLazyDone === "1") return true;
  const key = el.dataset.jsonPaneKey;
  if (key !== "request" && key !== "response") return true;
  let progress = jsonMaterializeStates.get(detail);
  if (progress === undefined) {
    const raw = key === "response" ? state.raw.response : state.raw.request;
    const path = JSON.parse(detail.dataset.jsonNodePath || "[]");
    const value = resolveJsonPathValue(raw, path);
    if (value === null || typeof value !== "object") return true;
    const depth = Number(detail.dataset.jsonDepth) || 0;
    const lineWidth = jsonLineWidthCache[key] || 0;
    const renderState = {
      formatMode: state.formatStrings[key] === true,
      lineWidth,
      wrap: state.wrap[key] === true,
      lazy: true,
    };
    let children = qsOn(detail, ":scope > .json-children");
    if (children === null) {
      detail.insertAdjacentHTML("beforeend", '<div class="json-children"></div>');
      children = qsOn(detail, ":scope > .json-children");
    }
    if (children === null) return true;
    progress = {
      value,
      path,
      depth,
      renderState,
      entries: jsonChildEntries(value),
      nextIndex: 0,
      children,
    };
    jsonMaterializeStates.set(detail, progress);
    detail.dataset.jsonMaterializing = "1";
  }
  const end = Math.min(progress.nextIndex + jsonMaterializeChunkSize, progress.entries.length);
  const chunk = progress.entries.slice(progress.nextIndex, end);
  if (progress.renderState.formatMode && progress.renderState.lineWidth > 0) {
    for (const [childKey, childValue] of chunk) {
      prepareJsonMeasurements(
        childValue,
        progress.renderState.lineWidth,
        Infinity,
        String(childKey),
        progress.depth + 1,
      );
    }
  }
  if (chunk.length > 0) {
    progress.children.insertAdjacentHTML(
      "beforeend",
      jsonChildEntriesMarkup(chunk, progress.depth, progress.path, progress.renderState),
    );
    recordJsonRenderedEntries(progress.children, chunk, progress.path);
    jsonRowWindowInvalidate(key);
  }
  progress.nextIndex = end;
  const complete = end >= progress.entries.length;
  const parentRow = closestOn(progress.children.parentElement, ".json-row");
  if (parentRow) {
    const estimatedLines =
      complete && progress.entries.length <= 500
        ? jsonLineCount(progress.value, progress.renderState)
        : Math.max(2, progress.nextIndex * 18 + 36);
    parentRow.style.containIntrinsicSize = `auto ${estimatedLines * 18}px`;
  }
  if (!complete) return false;
  detail.dataset.jsonLazyDone = "1";
  delete detail.dataset.jsonMaterializing;
  jsonMaterializeStates.delete(detail);
  return true;
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
  if (
    detail.dataset.jsonLazy !== "1" ||
    detail.dataset.jsonLazyDone === "1" ||
    detail.dataset.jsonMaterializing === "1"
  ) {
    return;
  }
  jsonMaterializeQueue.push({ el, detail });
  // Kick from a task so the click handler returns before materialization starts.
  if (!jsonMaterializeRunning) setTimeout(drainJsonMaterializeQueue, 0);
}
function drainJsonMaterializeQueue() {
  if (jsonMaterializeRunning) return;
  jsonMaterializeRunning = true;
  const start = performance.now();
  try {
    while (jsonMaterializeQueue.length) {
      const item = jsonMaterializeQueue.shift();
      if (!item.detail.isConnected) continue;
      const complete = materializeJsonNode(item.el, item.detail);
      // Fill first, open second. An incomplete node is queued for another task.
      item.detail.open = true;
      if (!complete) jsonMaterializeQueue.push(item);
      if (performance.now() - start >= jsonMaterializeBudgetMs) break;
    }
  } finally {
    // A fill that throws must not leave the flag set: every later enqueue would
    // then return here without doing anything, and the pane would stay showing an
    // empty subtree for the rest of the session.
    jsonMaterializeRunning = false;
    if (jsonMaterializeQueue.length) setTimeout(drainJsonMaterializeQueue, 0);
  }
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
  detailsOn(el, "details[data-json-node-path]").forEach((detail) => {
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
  detailsOn(el, "details[data-json-node-path]").forEach((detail) => {
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
/**
 * The view modes and the measured content width a render works from.
 *
 * They are read once per render so a rebuild never queries the DOM again: reading
 * `clientWidth` after the tree was mutated forces a synchronous re-layout of the whole
 * pane, and a per-string measurement fallback would force one layout for every string in
 * the subtree.
 * @typedef {{formatMode: boolean, lineWidth: number, wrap: boolean, lazy: boolean}} JsonRenderState
 */

/**
 * The size hint an offscreen row needs, in lines. `content-visibility` in app.css lets a
 * row skip layout and paint while it is offscreen, and the browser only knows its height
 * from this hint until it realizes the row.
 * @param {unknown} value
 * @param {JsonRenderState} renderState
 * @returns {number}
 */
function jsonLineCount(value, renderState) {
  if (value === null || typeof value !== "object") {
    // WeakMap only accepts objects, so primitives are never cached; counting
    // them is trivial anyway.
    return countJsonLinesWalk(
      value,
      renderState.formatMode,
      renderState.lineWidth,
      0,
      false,
      renderState.wrap,
    );
  }
  const cacheKey = `${renderState.formatMode ? 1 : 0}:${renderState.lineWidth}:${renderState.wrap ? 1 : 0}`;
  const cache = jsonLineCache.get(value);
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const lines = countJsonLinesWalk(
      value,
      renderState.formatMode,
      renderState.lineWidth,
      0,
      true,
      renderState.wrap,
    );
    cache.set(cacheKey, lines);
    return lines;
  }
  const lines = countJsonLinesWalk(
    value,
    renderState.formatMode,
    renderState.lineWidth,
    0,
    true,
    renderState.wrap,
  );
  jsonLineCache.set(value, new Map());
  jsonLineCache.get(value).set(cacheKey, lines);
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
/**
 * The three pieces a node renders in: the line its `<summary>` shows, the rows of its
 * children, and the closing bracket line.
 *
 * They are separate because a refresh rewrites only the piece that changed. A node whose
 * descendants changed but whose own summary did not keeps the summary the user is looking
 * at, and a node whose whole subtree is unchanged keeps all of its DOM.
 */

/** Whether a value renders as a node with children instead of as a single line. */
function jsonHasChildren(value) {
  return value !== null && typeof value === "object";
}
/** The bracket pair a container shows in its summary and in its closing line. */
function jsonBrackets(value) {
  return Array.isArray(value) ? ["[", "]"] : ["{", "}"];
}
/** The closing bracket line rendered after a container's children. */
function jsonEndMarkup(value) {
  return jsonBrackets(value)[1];
}
/**
 * The line a node shows in its `<summary>`: the key, the value's shape, and for a container
 * how many children it has. A formatted string is the only summary that can cost a layout,
 * because deciding whether it fits on one line needs a measured width.
 * @param {unknown} value
 * @param {string} key
 * @param {number} depth
 * @param {readonly string[]} path
 * @param {JsonRenderState} renderState
 * @returns {string}
 */
function jsonSummaryMarkup(value, key, depth, path, renderState) {
  const keyHtml =
    key === "" ? "" : `<span class="json-key">${escapeHtml(JSON.stringify(key))}</span>: `;
  if (jsonHasChildren(value)) {
    const [start, end] = jsonBrackets(value);
    const count = jsonChildEntries(value).length;
    return `${keyHtml}${start}<span class="json-muted">${count ? ` ${count} ${t("items")} ` : ""}</span>${end}`;
  }
  if (jsonType(value) === "string") {
    const plain = `${keyHtml}<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
    if (!renderState.formatMode) return plain;
    const text = String(value);
    const displayValue = formatString(value);
    const hasNewline = displayValue.indexOf(String.fromCharCode(10)) !== -1;
    const shouldFormat = hasNewline || text.indexOf("\\") !== -1 || text.indexOf('"') !== -1;
    const tooWide =
      !hasNewline &&
      renderState.lineWidth > 0 &&
      !jsonTextFitsOnLine(displayValue, key, depth, renderState.lineWidth);
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
  const type = jsonType(value);
  if (type === "number")
    return `${keyHtml}<span class="json-number">${escapeHtml(String(value))}</span>`;
  if (type === "boolean")
    return `${keyHtml}<span class="json-boolean">${escapeHtml(String(value))}</span>`;
  if (type === "undefined") return `${keyHtml}<span class="json-null">undefined</span>`;
  return `${keyHtml}<span class="json-null">null</span>`;
}
/** The rows for a subset of a node's children, in their source order. */
function jsonChildEntriesMarkup(entries, depth, path, renderState) {
  return entries
    .map(([childKey, childValue]) => {
      const key = jsonChildKey(childKey);
      return jsonRowMarkup(
        childValue,
        key,
        depth + 1,
        childNodePath(path, key),
        renderState,
        depth + 1 < defaultJsonExpandedDepth,
        false,
      );
    })
    .join("");
}
/** The rows for a node's children, in the order the pane shows them. */
function jsonChildrenMarkup(value, depth, path, renderState) {
  return jsonChildEntriesMarkup(jsonChildEntries(value), depth, path, renderState);
}
/**
 * The markup of one node. A leaf's summary line is its whole markup; a container gets the
 * `<details>` the pane drives. `renderState.lazy` leaves the children of a node that starts
 * closed to be built when the user opens it, so the first paint pays for the visible levels.
 * @param {unknown} value
 * @param {string} key
 * @param {number} depth
 * @param {readonly string[]} path
 * @param {JsonRenderState} renderState
 * @param {boolean} open
 * @param {boolean} root
 * @returns {string}
 */
function jsonNodeMarkup(value, key, depth, path, renderState, open, root) {
  const summary = jsonSummaryMarkup(value, key, depth, path, renderState);
  if (!jsonHasChildren(value)) return summary;
  const end = jsonEndMarkup(value);
  const childrenHtml =
    renderState.lazy && !open
      ? `<div class="json-children"></div>`
      : `<div class="json-children">${jsonChildrenMarkup(value, depth, path, renderState)}</div>`;
  const openAttr = open ? " open" : "";
  const lazyAttr = renderState.lazy && !open ? ' data-json-lazy="1"' : "";
  return `<details${openAttr} class="json-node${root ? " root" : ""}" data-json-depth="${depth}" style="--json-sticky-depth: ${depth}" data-json-node-path="${jsonNodePathAttr(path)}"${lazyAttr}><summary>${summary}</summary>${childrenHtml}<div class="json-muted">${end}</div></details>`;
}
/**
 * The markup for one rendered row: the node itself, the `contain-intrinsic-size` hint the
 * browser needs while the row is offscreen, and the child key the next refresh matches it
 * against.
 * @param {unknown} value
 * @param {string} key
 * @param {number} depth
 * @param {readonly string[]} path
 * @param {JsonRenderState} renderState
 * @param {boolean} open
 * @param {boolean} isRoot
 * @returns {string}
 */
function jsonRowMarkup(value, key, depth, path, renderState, open, isRoot) {
  const content = jsonNodeMarkup(value, key, depth, path, renderState, open, isRoot);
  if (isRoot) return `<div class="json-row json-pane-root">${content}</div>`;
  const lines = jsonLineCount(value, renderState);
  return `<div class="json-row" data-json-child-key="${escapeHtml(key)}" style="contain-intrinsic-size: auto ${lines * 18}px">${content}</div>`;
}
/** Builds one element from a markup string, the way the log list does it. */
function jsonElementFromMarkup(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const element = template.content.firstElementChild;
  if (element === null) throw new Error("JSON row markup must contain an element");
  if (!(element instanceof HTMLElement)) throw new Error("JSON row markup is not an element");
  return element;
}
/**
 * What each rendered row was built from.
 *
 * The pane compares this raw value with the new one instead of rebuilding markup, which is
 * what keeps an unchanged subtree untouched: its DOM nodes, its already-materialized
 * children and the user's expansion inside it all survive a refresh.
 */
const jsonRenderedRows = new WeakMap();
/** The view modes the pane's current DOM was built from; a change forces a whole rebuild. */
const jsonPaneSignatures = new Map();
/** @param {HTMLElement} row @param {unknown} raw @returns {void} */
function rememberJsonRow(row, raw) {
  jsonRenderedRows.set(row, { raw, summary: jsonSummarySignature(raw) });
}
/** @param {HTMLElement} container @returns {HTMLElement[]} */
function jsonChildRows(container) {
  return qsaOn(container, ":scope > .json-row");
}
/** @param {HTMLElement[]} rows @returns {Map<string, HTMLElement>} */
function jsonRowIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = row.dataset.jsonChildKey;
    if (key !== undefined) index.set(key, row);
  }
  return index;
}
/** Records the rows for a subset of a node's children. */
function recordJsonRenderedEntries(container, entries, path) {
  const index = jsonRowIndex(jsonChildRows(container));
  for (const [key, child] of entries) {
    const childKey = jsonChildKey(key);
    const row = index.get(childKey);
    if (row === undefined) continue;
    rememberJsonRow(row, child);
    const details = detailsOn(row, ":scope > details")[0] ?? null;
    const children = details === null ? null : qsOn(details, ":scope > .json-children");
    if (
      children === null ||
      children.firstElementChild === null ||
      child === null ||
      typeof child !== "object"
    ) {
      continue;
    }
    recordJsonRenderedRows(children, child, childNodePath(path, childKey));
  }
}
function recordJsonRenderedRows(container, value, path) {
  recordJsonRenderedEntries(container, jsonChildEntries(value), path);
}
/**
 * Creates a row the pane has never rendered, in the state a first paint would have given it.
 * @param {unknown} value
 * @param {string} key
 * @param {readonly string[]} path
 * @param {number} depth
 * @param {JsonRenderState} renderState
 * @returns {HTMLElement}
 */
function createJsonRow(value, key, path, depth, renderState) {
  const open = depth < defaultJsonExpandedDepth;
  const row = jsonElementFromMarkup(
    jsonRowMarkup(value, key, depth, path, renderState, open, false),
  );
  rememberJsonRow(row, value);
  return row;
}
/**
 * Brings one live row in step with a new raw value, touching only what differs.
 *
 * A node whose raw value is structurally identical does no work at all, which is what makes
 * a refresh of an unchanged body free. A node that changed keeps its own `<details>`: the
 * summary line is rewritten and its children are reconciled, so a large subtree whose one
 * leaf changed is not rebuilt. Only a row whose shape changed - a leaf that became a node,
 * a node that became a leaf, or a formatted string whose text changed - is replaced.
 * @param {HTMLElement} el
 * @param {HTMLElement} row
 * @param {unknown} value
 * @param {string} key
 * @param {readonly string[]} path
 * @param {number} depth
 * @param {JsonRenderState} renderState
 * @returns {JsonSyncedRow}
 */
function syncJsonRow(el, row, value, key, path, depth, renderState) {
  const remembered = jsonRenderedRows.get(row);
  if (remembered !== undefined && sameJsonValue(remembered.raw, value)) {
    return { row, changed: false };
  }
  const details = detailsOn(row, ":scope > details")[0] ?? null;
  const structure =
    details !== null &&
    details.classList.contains("json-node") &&
    value !== null &&
    typeof value === "object";
  if (!structure) {
    const fresh = jsonElementFromMarkup(
      jsonRowMarkup(value, key, depth, path, renderState, false, false),
    );
    rememberJsonRow(fresh, value);
    row.replaceWith(fresh);
    return { row: fresh, changed: true };
  }
  const open = details.open || depth < defaultJsonExpandedDepth;
  const lazy = renderState.lazy && !open;
  // Only the descendants changed: the summary line is what it was, so the node the user is
  // looking at keeps its own DOM instead of churning on the way down to what changed. When
  // the count of children changed, the count text alone is rewritten.
  if (remembered === undefined || remembered.summary !== jsonSummarySignature(value)) {
    const summary = qsOn(details, ":scope > summary");
    if (summary !== null) {
      const count = qsOn(summary, ":scope > .json-muted");
      const childCount = jsonHasChildren(value) ? jsonChildEntries(value).length : 0;
      if (
        count !== null &&
        childCount > 0 &&
        remembered !== undefined &&
        jsonSummaryShape(remembered.raw) === jsonSummaryShape(value) &&
        jsonSummaryShape(value) !== ""
      ) {
        count.textContent = ` ${childCount} ${t("items")} `;
      } else {
        summary.innerHTML = jsonSummaryMarkup(value, key, depth, path, renderState);
      }
    }
  }
  details.dataset.jsonDepth = String(depth);
  details.dataset.jsonNodePath = JSON.stringify(path);
  details.style.setProperty("--json-sticky-depth", String(depth));
  if (lazy) details.setAttribute("data-json-lazy", "1");
  else details.removeAttribute("data-json-lazy");
  const wasOpen = details.open;
  details.open = open;
  if (open && details.dataset.jsonLazy === "1" && !wasOpen) {
    enqueueJsonMaterialize(el, details);
  }
  row.style.containIntrinsicSize = `auto ${jsonLineCount(value, renderState) * 18}px`;
  rememberJsonRow(row, value);
  if (lazy) return { row, changed: true };
  const children = qsOn(details, ":scope > .json-children");
  if (children === null) return { row, changed: true };
  return { row, changed: syncJsonChildren(el, children, path, depth, value, renderState) };
}
/**
 * What a reconciled row left behind: the element that now stands where the row was, and
 * whether the DOM changed. The element is reported because a row whose shape changed is
 * replaced, and what follows it has to be lined up against the row that is in the document
 * rather than the one that was taken out of it.
 * @typedef {{row: HTMLElement, changed: boolean}} JsonSyncedRow
 */
/**
 * Whether `row` already comes after `previous` in this container. The scan stops at the row,
 * so the common case - the order did not change - costs one sibling step per row.
 * @param {HTMLElement} row
 * @param {HTMLElement} previous
 * @returns {boolean}
 */
function jsonRowFollows(row, previous) {
  for (let node = previous.nextElementSibling; node !== null; node = node.nextElementSibling) {
    if (node === row) return true;
  }
  return false;
}
/**
 * Brings a live node's children in step with a new raw value.
 *
 * Rows whose key disappeared are removed, rows that are already in the right place are left
 * alone, and a row that is only in the wrong place is moved - never rebuilt. Newly created
 * rows are inserted after the previous sibling, so the DOM order follows the entry order
 * without moving every row that was already correct.
 * @param {HTMLElement} el
 * @param {HTMLElement} container
 * @param {readonly string[]} parentPath
 * @param {number} parentDepth
 * @param {unknown} value
 * @param {JsonRenderState} renderState
 * @returns {boolean}
 */
function syncJsonChildren(el, container, parentPath, parentDepth, value, renderState) {
  const entries = jsonChildEntries(value);
  const index = jsonRowIndex(jsonChildRows(container));
  const wanted = new Set(entries.map(([key]) => jsonChildKey(key)));
  let changed = false;
  for (const [key, row] of index) {
    if (wanted.has(key)) continue;
    row.remove();
    changed = true;
  }
  let previous = null;
  for (const [key, child] of entries) {
    const childKey = jsonChildKey(key);
    const childPath = childNodePath(parentPath, childKey);
    const existing = index.get(childKey);
    if (existing !== undefined) {
      const placed = syncJsonRow(
        el,
        existing,
        child,
        childKey,
        childPath,
        parentDepth + 1,
        renderState,
      );
      if (placed.changed) changed = true;
      // A key that arrived in a different position has to show in that position too, so a
      // row that ended up behind a later entry is moved back in front of it.
      if (previous !== null && !jsonRowFollows(placed.row, previous)) {
        container.insertBefore(placed.row, previous.nextElementSibling);
        changed = true;
      }
      previous = placed.row;
      continue;
    }
    const created = createJsonRow(child, childKey, childPath, parentDepth + 1, renderState);
    container.insertBefore(
      created,
      previous === null ? container.firstElementChild : previous.nextElementSibling,
    );
    previous = created;
    changed = true;
  }
  return changed;
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
function prepareJsonMeasurements(value, lineWidth, maxDepth = Infinity, key = "", depth = 0) {
  // Intrinsic text widths use a fixed font and do not depend on pane width.
  // Pane width only decides which strings need probes; retain those measurements
  // across panes and resizes, with a cap for long sessions.
  if (jsonMeasureResults.size > 20_000) {
    jsonMeasureResults = new Map();
  }
  if (lineWidth <= 0) return;
  const probes = [];
  collectJsonMeasureProbes(value, key, depth, lineWidth, probes, maxDepth);
  if (!probes.length) return;
  const missing = [...new Set(probes)].filter((probe) => !jsonMeasureResults.has(probe));
  if (missing.length === 0) return;
  const box = ensureJsonMeasureBox();
  box.textContent = "";
  const measured = [];
  for (const probe of missing) {
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
/**
 * The render state of one pane: the view modes it is showing and whether the body is big
 * enough to render lazily.
 * @param {string} key
 * @returns {JsonRenderState}
 */
function jsonRenderState(key) {
  return {
    formatMode: state.formatStrings[key] === true,
    lineWidth: jsonLineWidthCache[key] || 0,
    wrap: state.wrap[key] === true,
    lazy: jsonEntryCount(state.raw[key], lazyJsonEntryLimit) > lazyJsonEntryLimit,
  };
}
/**
 * The signature the pane's current DOM was built from.
 *
 * Everything in it changes the markup of every node, so a change means a whole rebuild.
 * The raw value is deliberately absent: that one is reconciled node by node, which is the
 * whole point of keeping the rendered rows.
 * @param {string} key
 * @param {JsonRenderState} renderState
 * @returns {string}
 */
function jsonPaneSignature(key, renderState) {
  return JSON.stringify([
    state.language,
    state.tree[key],
    renderState.formatMode,
    renderState.lineWidth,
    renderState.wrap,
    renderState.lazy,
  ]);
}
/**
 * Records what a freshly built tree was rendered from, so the next refresh reconciles it
 * instead of replacing it.
 * @param {HTMLElement} el
 * @param {unknown} raw
 * @returns {void}
 */
function seedJsonRenderedRows(el, raw) {
  const rootRow = qsOn(el, ":scope > .json-row");
  if (rootRow === null) return;
  rememberJsonRow(rootRow, raw);
  const details = detailsOn(rootRow, ":scope > details")[0] ?? null;
  const children = details === null ? null : qsOn(details, ":scope > .json-children");
  if (children !== null && raw !== null && typeof raw === "object") {
    recordJsonRenderedRows(children, raw, []);
  }
}
export function renderJsonPane(key, options = {}) {
  const el = $(key + "Json");
  // Cache the content width while the DOM is still clean: reading it later,
  // after the tree was mutated, forces a synchronous re-layout.
  jsonLineWidthCache[key] = el.clientWidth > 24 ? el.clientWidth - 24 : 0;
  el.classList.toggle("wrap", state.wrap[key]);
  el.classList.toggle("nowrap", !state.wrap[key]);
  if (!state.tree[key]) {
    // The plain-text view has no nodes to reconcile: it is one serialized string.
    jsonPaneSignatures.delete(key);
    const text = jsonText(state.raw[key]);
    if (text !== state.jsonPaneHtml[key]) {
      state.jsonPaneHtml[key] = text;
      el.textContent = text;
      jsonRowWindowInvalidate(key);
    }
    updateExpandButton(key);
    updatePaneButtons(key);
    return;
  }
  el.dataset.jsonPaneKey = key;
  const renderState = jsonRenderState(key);
  if (renderState.formatMode) {
    prepareJsonMeasurements(state.raw[key], renderState.lineWidth, defaultJsonExpandedDepth);
  }
  const signature = jsonPaneSignature(key, renderState);
  const rootRow = qsOn(el, ":scope > .json-row");
  // The pane may only reconcile what it already rendered for this record. A view-mode
  // change, a language switch, a width change or a newly selected record rebuilds the tree.
  const canReconcile =
    options.resetView !== true &&
    jsonPaneSignatures.get(key) === signature &&
    rootRow !== null &&
    el.dataset.jsonPaneKey === key;
  jsonPaneSignatures.set(key, signature);
  if (canReconcile) {
    // Nothing is assigned into the pane and no scroll offset is written, so the pane keeps
    // its scroll position and every row the user had expanded, and an unchanged body costs
    // one comparison at the root.
    const synced = syncJsonRow(el, rootRow, state.raw[key], "", [], 0, renderState);
    if (!synced.changed) return;
    jsonRowWindowInvalidate(key);
    updateExpandButton(key);
    updatePaneButtons(key);
    return;
  }
  const viewState = options.preserveView ? collectJsonPaneViewState(el) : null;
  el.innerHTML = jsonRowMarkup(
    state.raw[key],
    "",
    0,
    [],
    renderState,
    0 < defaultJsonExpandedDepth,
    true,
  );
  jsonRowWindowInvalidate(key);
  seedJsonRenderedRows(el, state.raw[key]);
  restoreJsonPaneViewState(el, viewState);
  updateExpandButton(key);
  updatePaneButtons(key);
}

function hasMetadata(value) {
  return Boolean(value && typeof value === "object" && Object.keys(value).length);
}
const metaRenderState = { formatMode: true, lineWidth: 0, wrap: false, lazy: false };
export function renderMetaPane(key) {
  const el = $(key + "Meta");
  const available = hasMetadata(state.meta[key]);
  const open = available && state.metaOpen[key];
  el.hidden = !open;
  el.innerHTML = open
    ? jsonNodeMarkup(state.meta[key], "", 0, [], metaRenderState, true, true)
    : "";
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
        ? durationMs === undefined
          ? undefined
          : durationMs - tokenMs
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
  const button = optionalTyped(`[data-meta="${key}"]`, HTMLButtonElement);
  if (!button) return;
  const available = hasMetadata(state.meta[key]);
  button.disabled = !available;
  button.classList.toggle("active", available && state.metaOpen[key]);
  button.title = available && state.metaOpen[key] ? t("hideMetadata") : t("showMetadata");
}
function updatePaneButtons(key) {
  requiredTyped(`[data-wrap="${key}"]`, HTMLButtonElement).classList.toggle(
    "active",
    state.wrap[key],
  );
  requiredTyped(`[data-format="${key}"]`, HTMLButtonElement).classList.toggle(
    "active",
    state.formatStrings[key],
  );
  const expandBtn = qs(`[data-expand="${key}"]`);
  if (expandBtn) {
    const details = detailsOn($(key + "Json"), "details:not(.json-str-detail)");
    const allOpen = details.length > 0 && details.every((detail) => detail.open);
    expandBtn.classList.toggle("active", !allOpen);
  }
}
function updateExpandButton(key) {
  const button = qs(`[data-expand="${key}"]`);
  if (!button) return;
  const details = detailsOn($(key + "Json"), "details:not(.json-str-detail)");
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
