// LLM Proxy admin UI -- proxy config module adapter (classic-script load order).
let proxyConfig;
function initializeProxyConfig() {
  if (!proxyConfig) {
    proxyConfig = createProxyConfig({
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
  }
  proxyConfig.init();
}
