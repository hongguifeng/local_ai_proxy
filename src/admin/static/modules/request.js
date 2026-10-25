/** Forward both cancellation owners without relying on AbortSignal.any().
 * @template {import("../../ui-contracts.js").ApiPath} Path
 * @param {import("../../ui-contracts.js").ApiClient} request
 * @param {Path} url
 * @param {RequestInit} options
 * @param {AbortSignal | undefined} lifecycleSignal
 * @returns {Promise<import("../../ui-contracts.js").ApiResult<Path>>}
 */
export async function requestWithCancellation(request, url, options, lifecycleSignal) {
  const signals = [
    ...new Set([lifecycleSignal, options.signal].filter((signal) => signal != null)),
  ];
  if (signals.length < 2) return request(url, { ...options, signal: signals[0] ?? null });
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  try {
    return await request(url, { ...options, signal: controller.signal });
  } finally {
    for (const signal of signals) signal.removeEventListener("abort", abort);
  }
}
