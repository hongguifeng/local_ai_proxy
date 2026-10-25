// LLM Proxy admin UI -- the browser tests' only entry into module internals.
// ES module: this is an adapter, not a production capability. Three things cannot be
// driven through the DOM from a test -- applying a synthetic multi-megabyte body, the
// exact currency formatter, and the lifecycle of the two config surfaces -- so the
// composition root publishes them on one frozen, namespaced object. Production code never
// reads it, and no module publishes anything else on a global.

/**
 * Publishes the test surface. Called once, from `startAdminUi()`.
 * @param {{
 *   applySelectedLogDetail: (data: unknown, options?: Record<string, unknown>) => void,
 *   formatCurrencyAmount: (amount: unknown) => string,
 *   proxyConfig: { init: () => void, dispose: () => void, load: () => Promise<unknown> },
 *   loadBalancing: { dispose: () => void },
 * }} surfaces
 * @returns {void}
 */
export function installAdminUiTestAdapter({
  applySelectedLogDetail,
  formatCurrencyAmount,
  proxyConfig,
  loadBalancing,
}) {
  globalThis.__adminUiTest = Object.freeze({
    applySelectedLogDetail,
    formatCurrencyAmount,
    proxyConfig,
    loadBalancing,
  });
}
