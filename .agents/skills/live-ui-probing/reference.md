# Live-instance probes: recipes and measured results

Incident history and measurements behind [SKILL.md](./SKILL.md).

## Patching the instance's own script

Outline that worked: read the admin port from the portable instance's
`llm-proxy.json`, have Playwright intercept `**/static/app.js`, fetch the instance's own
response, replace the function you need to instrument at its definition site, and serve the
patched body. Serving the working tree's `dist-node/.../admin-app.js` instead fails at load
because that file still contains the `__SUGGESTED_STRIP_REQUEST_FIELDS__` placeholder; the
page reports a `ReferenceError` and nothing renders, which looks like a timeout.

The same route interception is how a served-script patch is proven to have executed:
`getEventListeners` is a DevTools-console function and CDP `DOMDebugger.getEventListeners`
returns an empty function description here, so a global hit counter inside the patched
script is the evidence.

`page.addInitScript` serializes the function body, so a body that reads a Node-side closure
variable silently never sees it. A probe that ignored the language it asked for was an
init-script bug, not a page bug; pass the value as Playwright's own second argument or
inline the literal.

## Throwaway harness instead of a UI test file

A throwaway Node script that imports `createAdminServer` and `loadAdminStaticAssets` from
`dist-node` with a stub `logService`, opens the page with the Playwright-bundled Chromium and
screenshots `.log-list` at several `--sidebar-w` values answers layout questions much faster
than patching a browser test. `loadAdminStaticAssets` reads the bundle from `dist-node`, so
`npm run bundle:ui` is required after editing JS and `node dist-node/scripts/copy_static_assets.js`
after editing `app.css`/`index.html`; otherwise the harness silently serves the previous
stylesheet.

## Measured numbers

- A detail-prefetch probe on the real instance with a 5.8 MB body: hover-then-click ~25 ms
  versus ~400 ms before the prefetch existed. A cold click with no hover stays bound by the
  transfer.
- Click-to-visible on a paged list measured through `page.click` wall clock was ~100 ms of
  Playwright overhead; the in-page mark pair removed it.
- Layout numbers that came from `getBoundingClientRect` probes rather than eyeballing: the
  30 px time-center gap in the task-detail summary, the 316 px `auto` grid track, and the
  sidebar width at which `.log-list` starts clipping.

## Cascade digest on a live page

For a CSS change the digest over `document.querySelectorAll("*")` is compared as a set of
style signatures. The live instance keeps ingesting records, so index alignment is
meaningless and a real cascade change makes one signature disappear and another appear,
while data drift only changes how many elements share a signature. Both effects reproduce
with an unchanged stylesheet on the statistics page, which is why that page is judged by the
stubbed harness instead.
