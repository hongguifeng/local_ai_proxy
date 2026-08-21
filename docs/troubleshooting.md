# Node and Electron Troubleshooting

## CLI does not start

- Confirm `node --version` is Node 24.x and reinstall with `npm ci` after changing Node versions.
- `EADDRINUSE` identifies the occupied host/port. Change `--port` for the admin UI, or change the pair's
  listen port in `proxies.json` after stopping the conflicting process.
- Invalid JSON or schema errors include the resolved config path. Restore the automatic
  `before-node-*.bak` file or use a known-good config.
- If the UI assets are missing from `dist-node`, run `npm run build`; TypeScript compilation alone does
  not copy `src/admin/static`.

## SQLite native module errors

`better-sqlite3` is native code and must match its runtime ABI. The standard build, development,
start, and test npm lifecycles rebuild it for Node before use. Electron packaging rebuilds it for the
pinned Electron runtime. If the native module is damaged rather than merely built for the other
runtime, remove `node_modules` and run `npm ci` with Node 24.

## Tray application

- A second launch activates the existing instance instead of opening another set of ports.
- Use the tray **Exit** action and wait for shutdown before replacing files or restarting.
- `--open-on-start` or `LLM_PROXY_OPEN_ON_START=1` opens the admin page after startup.
- Unsigned Windows artifacts may display SmartScreen warnings; verify `SHA256SUMS.txt` before running.
- If no tray icon appears under Linux desktop testing, ensure a status notifier implementation is
  available. The supported release target is Windows.

## Browser and tests

The UI E2E suite requires Google Chrome at `/usr/bin/google-chrome` in the current Linux setup. A
missing browser affects E2E/visual tests but not the Node CLI runtime. Use `npm test -- --run
test-node/ui/admin-ui.test.ts` to isolate UI failures.

If local requests unexpectedly use an HTTP proxy, exclude `127.0.0.1` and `localhost` through
`NO_PROXY`; otherwise health checks can be sent to the external proxy rather than the local UI.

## Upstream target not responding

If clients see connection errors or odd upstream statuses, click **Test** on the target card in the
admin UI. The check sends a minimal ping directly from the admin server to the upstream (it does not
pass through the proxy listener and is not recorded in the traffic history), which separates the
common causes:

- **Red failure**: the network cannot reach the upstream. Check the target URL, DNS, firewall, or
  whether the upstream process is running.
- **Orange warning with HTTP 401/403**: authentication failed. Verify the API key and the API type
  in the check dialog (Chat Completions and Responses use `Authorization: Bearer`; Anthropic uses
  `x-api-key`).
- **Orange warning with HTTP 404**: unknown model or wrong base path. Verify the model ID and the
  target URL base path (for example whether it includes `/v1`).
- **Green success**: the upstream is healthy, so the problem is likely in the local client
  configuration or proxy routing instead.
