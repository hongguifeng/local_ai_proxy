---
name: static-checks-and-split
description: >-
  The admin UI is one bundled ES module graph: src/admin/static/entry.js and modules/ are
  esbuild-bundled into ADMIN_BUNDLE_FILE and served as /static/app.js, the bundler runs from
  build, lint, dev and every test entry, lint and tsconfig.ui.json check the modules directly,
  and __adminUiTest is the only global. Use when editing browser modules under
  src/admin/static, their tests, or the UI build and static-check entry points.
---

# The admin UI module graph and its static checks

## When this applies

- You edit `src/admin/static/entry.js`, `src/admin/static/modules/*.js` or `index.html`.
- You change which script the server serves, or how the UI build is wired.
- A UI browser test reports a missing bundle, a stale script, or an unexpected global.

## Invariants

- `/static/app.js` is exactly the bundle of `src/admin/static/entry.js` and what it imports.
  `entry.js` calls `startAdminUi()`; `modules/wiring.js` is the composition root;
  `modules/core.js` owns the one mutable `state`, the `$`/`api`/`toast` helpers and the
  language-panel registry. There are no numbered scripts and no load-order contract.
- `npm run bundle:ui` (`scripts/build_ui_bundle.ts`, esbuild, `format: "iife"`) writes
  `ADMIN_BUNDLE_FILE` at `dist-node/src/admin/static-bundle/admin-app.js`, and the server
  answers `/static/app.js` with exactly that text. The chunk sits beside the compiled static
  assets, never inside `src/admin/static`, so the stale-asset guard in
  `scripts/copy_static_assets.ts` cannot delete it; `src/admin/static-assets.ts` finds it by
  walking up to the directory holding `package.json`, which is the same rule in source, in
  `dist-node` and inside `app.asar`.
- A missing bundle is an error at page load, never an empty script. The read retries `ENOENT`
  for the same bounded window as a Windows sharing violation, which is why the bundler is
  wired into `build`, `lint`, `dev` and every test entry point (`test`, `test:coverage`,
  `test:watch`) and into `startStubAdminServer` in `test-node/ui/admin-ui-server.ts`.
- The `pre*` lifecycle hooks stay exactly `npm run rebuild:node`:
  `test-node/electron/builder-config.test.ts` pins that string so a Node lifecycle can never
  skip the ABI restore.
- `npm run lint` runs the bundler and then lints the module sources directly, so a missing
  sibling import is `no-undef`. Sibling modules are deliberately absent from the configured
  globals, which is what stops a module from reading a global instead of importing it.
- `npm run typecheck` checks the same files through `tsconfig.ui.json` (`allowJs` + `checkJs`,
  `strictNullChecks`, `exactOptionalPropertyTypes`). Its `moduleDetection: "legacy"` no longer
  changes anything now that every file imports a sibling, but leave it alone.
- `modules/dom.js` returns concrete `HTMLElement` values for general HTML queries and uses
  constructor-checked `requiredTyped`/`optionalTyped` for controls, with selector-bearing
  errors. Statistics card filters are created only after a response renders cards, so they must
  stay optional during startup. `src/admin/ui-contracts.d.ts` owns the shared state, async
  panel and API path/result types.
- Nothing is published on `globalThis` except the frozen `__adminUiTest` object
  (`modules/test-adapter.js`, installed by the composition root): `applySelectedLogDetail`,
  `formatCurrencyAmount`, `proxyConfig.init/dispose/load` and `loadBalancing.dispose`.
  Production code never reads it.
- A language switch in a test drives the real control (`#languageSelect` plus a dispatched
  `change`), not `page.selectOption` when an assertion is watching focus.
- Mechanical typing rewrites (`asElement`, `qsOn`, `closestOn`, `String(...)` wrappers) change
  runtime code, so the UI suite with pixel baselines is the only proof they are
  behavior-neutral.

## Standard commands

```bash
npm run bundle:ui
npm run lint
npm run typecheck
npm test -- test-node/admin/static-source.test.ts test-node/admin/static-bridge.test.ts
npm test -- test-node/admin/build-ui-bundle.test.ts test-node/admin/ui-types.test.ts
npm test -- test-node/ui/admin-ui-dom-contracts.test.ts
```

## Reading the result

- `static-source.test.ts` fails first and fastest for a formatting or file-layout mistake: it
  formats `entry.js` and every module, and asserts the directory holds only `index.html`,
  `app.css`, `entry.js` and `modules/`. Run `npx prettier --write` on the files you touched
  before the full suite.
- `static-bridge.test.ts` proves the migration stayed gone: the only global write is
  `__adminUiTest`, no production module reads it, every module is reachable from `entry.js`,
  the display helpers stay DOM-free, and the served `/static/app.js` is byte-identical to
  `buildAdminAppJsTemplate()` after the strip-fields substitution.
- `ui-types.test.ts` covers the shared-type surface and pins compiler rejection cases;
  `admin-ui-dom-contracts.test.ts` exercises real Chromium lookups and broken initialization.
- A missing bundle surfaces as a startup error naming the build command, not as a blank page.

## Deeper material

- [reference.md](./reference.md) — the bundle-retry measurement, the packaged-delivery proof
  and the strict-type contract details.
- [模块边界](../../../docs/current/contracts/module-boundaries.md) — 当前模块拆分和静态检查
  configuration.
- [current-architecture.md](../../../docs/current/architecture.md) §5 and §7 — where the UI
  source lives and which command verifies it.
