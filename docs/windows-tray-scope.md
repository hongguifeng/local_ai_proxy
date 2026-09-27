# Windows Auto Start

The Windows tray application starts only when the user launches it, except when auto start is
enabled. The tray context menu contains a "Start with Windows" entry: toggling it on enables
Windows login startup and toggling it off removes it. The current state is shown in the label —
a check mark (✓) when enabled and a hollow dot (·) when disabled — because Windows tray menus
render a `checkbox` item as a plain square and ignore the `checked` flag.

For packaged builds, the app calls Electron's `setLoginItemSettings` API, which writes the
standard per-user Run entry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` pointing at the
installed executable (`"LLM Proxy.exe"` for the installer build). The choice is persisted in
`auto-start.json` in the application data directory, so it survives reboots; enabling it is a
per-user setting and requires no administrator rights.

The portable build also supports auto start. The NSIS launcher runs the app from a temporary
extraction directory that is deleted when the app exits, so Electron's default login-item path
(the unpacked copy) would point at a file that no longer exists at login. Instead, the app passes
the `path` option of `setLoginItemSettings` the original portable executable reported by the
launcher (`PORTABLE_EXECUTABLE_FILE`, falling back to `PORTABLE_EXECUTABLE_DIR` +
`PORTABLE_EXECUTABLE_APP_FILENAME`). Windows then starts the portable `.exe` itself at login, which
unpacks and runs normally. Because the login-item read-back compares the stored entry against the
queried path, the same `path` must be passed to `getLoginItemSettings`, which the app does.
Registering the portable executable also self-heals: after the exe is moved, the next launch
re-applies the persisted setting and rewrites the entry to the new location. If the exe is deleted
or renamed in place, the Run entry becomes dead and Windows silently fails to launch it.

One situation intentionally leaves the entry showing the disabled (·) state:

- Development (`npm run dev`) does not write a registry entry because the launch command is not a
  stable executable.

Auto start launches the tray application with its default settings; it does not open the admin UI.
