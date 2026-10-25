// LLM Proxy admin UI -- load balancing module adapter (classic-script load order).
let loadBalancing;
function initializeLoadBalancing() {
  if (!loadBalancing)
    loadBalancing = createLoadBalancing({
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
}
