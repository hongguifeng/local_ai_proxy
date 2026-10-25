// LLM Proxy admin UI -- the page's composition root: builds the two config surfaces, mounts
// every feature module's listeners, and runs the startup sequence once.
// ES module: this is the only place that knows about all features at once; production code
// reaches them through this module graph, never through a window property.

import {
  $,
  api,
  applyLanguage,
  asElement,
  closestFrom,
  closestOn,
  qs,
  qsa,
  qsaOn,
  qsOn,
  registerLanguagePanel,
  setLanguage,
  state,
  t,
  toast,
} from "./core.js";
import { applySelectedLogDetail, disposeHistory, loadLogs, mountHistory } from "./history.js";
import { applyPaneChrome, mountJsonPanes } from "./json-pane.js";
import { createLoadBalancing } from "./load-balancing.js";
import { formatCurrencyAmount } from "./money.js";
import { disposeMetrics, mountMetrics, openTargetMetricsDialog } from "./metrics.js";
import { createProxyConfig } from "./proxy-config.js";
import { loadStatistics, loadStatisticsOptions, mountStatistics } from "./statistics.js";
import { disposeTaskDetail, loadPricingGroupOpenState, mountTaskDetail } from "./task-detail.js";
import { installAdminUiTestAdapter } from "./test-adapter.js";

// Replaced by static-assets.ts before the browser ever sees this identifier, so the
// authored source is the only place the placeholder name exists.
// @ts-expect-error -- the name only exists in the authored source.
const suggestedStripRequestFields = __SUGGESTED_STRIP_REQUEST_FIELDS__;

// Both surfaces are built once and shared through the dependency object each factory takes:
// the load-balancing cards read pair configuration, and the proxy config opens the metrics
// dialog, so neither can be constructed on its own without the other.
const loadBalancing = createLoadBalancing({
  $,
  qs,
  qsa,
  qsaOn,
  qsOn,
  asElement,
  closestFrom,
  closestOn,
  t,
  api,
});
const proxyConfig = createProxyConfig({
  $,
  qs,
  qsa,
  qsaOn,
  qsOn,
  asElement,
  closestFrom,
  closestOn,
  t,
  toast,
  api,
  registerLanguagePanel,
  suggestedStripRequestFields,
  openTargetMetricsDialog,
  loadBalancing,
});

/**
 * Runs the page: two config surfaces first (they publish the panels the language switch
 * needs), then the feature listeners, then the first paint and the first request.
 * @returns {void}
 */
export function startAdminUi() {
  proxyConfig.init();
  // A page restored from the back/forward cache re-fires pageshow without re-running this
  // function, so the config surface reopens its lifecycle here rather than being built twice.
  window.addEventListener("pagehide", () => {
    proxyConfig.dispose();
    disposeHistory();
    disposeTaskDetail();
    disposeMetrics();
  });
  window.addEventListener("pageshow", () => proxyConfig.init());
  loadPricingGroupOpenState();
  mountHistory();
  mountTaskDetail();
  mountJsonPanes();
  mountStatistics();
  mountMetrics();
  $("languageSelect").addEventListener("change", (event) =>
    setLanguage(asElement(event.target).value),
  );
  qsa(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      qsa(".tab, .view").forEach((el) => el.classList.remove("active"));
      tab.classList.add("active");
      $(tab.dataset.tab).classList.add("active");
      loadBalancing.updatePolling();
      if (tab.dataset.tab === "logs") loadLogs().catch((e) => toast(e.message));
      if (tab.dataset.tab === "statistics")
        loadStatisticsOptions()
          .then(() => loadStatistics())
          .catch((e) => toast(e.message));
    }),
  );
  (() => {
    const detail = $("detail"),
      splitter = $("splitter");
    let dragging = false,
      previewFrame = 0,
      baseRect = null,
      baseTop = 0,
      baseY = 0,
      targetY = 0;
    const clampedTop = () =>
      Math.max(120, Math.min(baseRect.height - 120, baseTop + (targetY - baseY)));
    const previewTop = () => {
      previewFrame = 0;
      if (!dragging || !baseRect) return;
      splitter.style.setProperty("--splitter-preview-y", `${clampedTop() - baseTop}px`);
    };
    const clearPreview = () => {
      if (previewFrame) cancelAnimationFrame(previewFrame);
      previewFrame = 0;
      splitter.classList.remove("dragging");
      splitter.style.removeProperty("--splitter-preview-y");
    };
    splitter.addEventListener("pointerdown", (e) => {
      dragging = true;
      state.splitterDragging = true;
      splitter.setPointerCapture(e.pointerId);
      baseRect = detail.getBoundingClientRect();
      baseTop = splitter.offsetTop;
      baseY = e.clientY;
      targetY = e.clientY;
      splitter.classList.add("dragging");
    });
    splitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      targetY = e.clientY;
      if (!previewFrame) previewFrame = requestAnimationFrame(previewTop);
    });
    const stopDragging = (commit) => {
      if (!dragging) return;
      dragging = false;
      state.splitterDragging = false;
      if (commit && baseRect) {
        const top = clampedTop();
        detail.style.setProperty("--request-fr", `${top}px`);
        detail.style.setProperty("--response-fr", `${baseRect.height - top - 8}px`);
      }
      clearPreview();
      baseRect = null;
    };
    splitter.addEventListener("pointerup", () => stopDragging(true));
    splitter.addEventListener("pointercancel", () => stopDragging(false));
    splitter.addEventListener("lostpointercapture", () => stopDragging(false));
  })();
  (() => {
    const logsView = $("logs"),
      logSplitter = $("logSplitter"),
      logList = qs(".log-list");
    let dragging = false,
      previewFrame = 0,
      baseRect = null,
      baseWidth = 0,
      baseX = 0,
      targetX = 0;
    const clampedWidth = () =>
      Math.max(200, Math.min(baseRect.width * 0.8, baseWidth + (targetX - baseX)));
    const previewWidth = () => {
      previewFrame = 0;
      if (!dragging || !baseRect) return;
      logSplitter.style.setProperty("--splitter-preview-x", `${clampedWidth() - baseWidth}px`);
    };
    const clearPreview = () => {
      if (previewFrame) cancelAnimationFrame(previewFrame);
      previewFrame = 0;
      logSplitter.classList.remove("dragging");
      logSplitter.style.removeProperty("--splitter-preview-x");
    };
    logSplitter.addEventListener("pointerdown", (e) => {
      dragging = true;
      state.splitterDragging = true;
      logSplitter.setPointerCapture(e.pointerId);
      baseRect = logsView.getBoundingClientRect();
      baseWidth = logList.getBoundingClientRect().width;
      baseX = e.clientX;
      targetX = e.clientX;
      logSplitter.classList.add("dragging");
    });
    logSplitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      targetX = e.clientX;
      if (!previewFrame) previewFrame = requestAnimationFrame(previewWidth);
    });
    const stopDragging = (commit) => {
      if (!dragging) return;
      dragging = false;
      state.splitterDragging = false;
      if (commit && baseRect) logsView.style.setProperty("--sidebar-w", `${clampedWidth()}px`);
      clearPreview();
      baseRect = null;
    };
    logSplitter.addEventListener("pointerup", () => stopDragging(true));
    logSplitter.addEventListener("pointercancel", () => stopDragging(false));
    logSplitter.addEventListener("lostpointercapture", () => stopDragging(false));
  })();
  applyLanguage();
  applyLanguage();
  applyPaneChrome();
  proxyConfig.load().catch((e) => toast(e.message));
  loadStatisticsOptions().catch(() => {});
  // The browser tests are the only reader of this adapter; nothing in the page uses it.
  installAdminUiTestAdapter({
    applySelectedLogDetail,
    formatCurrencyAmount,
    proxyConfig,
    loadBalancing,
  });
}
