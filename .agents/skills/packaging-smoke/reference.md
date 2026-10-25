# Packaging and smoke: recipes and measurements

Background for [SKILL.md](./SKILL.md). Numbers here were measured on this repository and
are historical evidence, not current assertions.

## Reading one entry back out of app.asar

`@electron/asar`'s `extractFile(archive, filename)` needs both arguments, and the filename
must be the backslash-separated path **without** the leading `\` that `asar list` /
`listPackage` print:

```js
// dist-node\src\admin\static\app.js -> "dist-node\\src\\admin\\static\\app.js"
extractFile(archive, parts.join(String.fromCharCode(92))); // parts = ["dist-node", "src", ...]
```

The listed form (`\dist-node\src\...`) raises `"…" was not found in this archive`, and
forward-slash paths raise the same. A one-argument call reads the string as the archive path
and dies inside `readArchiveHeaderSync`. bash eats escaped backslashes in `node -e` and in
heredoc source, so build such a path inside a script file by joining segments.

## Payload contents

electron-builder's `files` enumerates the three compiled trees — `dist-node/src/**/*`,
`dist-node/electron/**/*`, `dist-node/scripts/**/*` — plus `package.json`. A merged payload
measured 3,085 entries with `dist-node` at 421: 336 `src`, 33 `electron`, 48 `scripts` files
plus 4 directory entries. A `dist-node/test-node` left behind by a pre-split build cannot be
packaged, but it does mislead anyone reasoning about what ships.

## Measured startup

A clean integrated `npm run smoke:delivery` run measured 3,436 ms to health for the portable
wrapper and 557 ms for the unpacked payload. The harness deadlines are 60 s for health, 30 s
for shutdown and 20 s for the database, so a timeout is an environment answer.

## Login items

Electron's `setLoginItemSettings` accepts a `path` option on Windows and registers that
executable under the Run value named `electron.app.<app name>`. The portable NSIS launcher
deletes its temp unpack directory on exit, so it exports stable paths: register
`PORTABLE_EXECUTABLE_FILE`, with `PORTABLE_EXECUTABLE_DIR` +
`PORTABLE_EXECUTABLE_APP_FILENAME` as the fallback (see `resolveLoginItemPath` in
`electron/auto-start.ts`). Read-back is path-sensitive — `getLoginItemSettings` must receive
the same `path`/`args` used at write time or `openAtLogin` reports false — while turning the
item off removes the value by name regardless of `path`.

These semantics are cheap to probe with a `.cjs` Electron script run through
`npx electron`; the harness shell presets `ELECTRON_RUN_AS_NODE=1`, which silently degrades
that launch to plain Node, so clear it from the child environment.

## Shell traps around a Windows child process

- This shell expands `$_`, which breaks PowerShell one-liners (`$_` becomes
  `/usr/bin/bash.ProcessName`); run PowerShell logic from a `.ps1` file, or use `tasklist`.
  `Get-CimInstance Win32_Process` with `CreationDate`, `ExecutablePath` and `CommandLine` is
  what tells the user's instance apart from a smoke launch.
- `spawn("node", …)` fails with `spawn node ENOENT`; spawn `process.execPath` instead.
- A bash `/tmp/...` cwd is not usable for a Windows child process. Take the throwaway cwd
  from `os.tmpdir()` and give the executable an absolute `path.resolve(...)` path inside it,
  because a relative exe path resolves against that cwd and fails with `spawn … ENOENT`.

## Real data against the payload

The production `traffic.db` was ~10 GB when this was measured, so give a real-data launch a
generous health deadline and point at the real log root instead of copying that file. Copy
the pairs config instead, move its `listen_port` off the port the user's instance holds, and
move `summary_model.target_url` with it when it points back at that same listener — otherwise
the model call hits a dead port.

Comparing the packaged `better_sqlite3.node` with the file in `node_modules` proved nothing:
the bytes were identical while the app still opened the database. Loading one through the
admin API is the evidence.
