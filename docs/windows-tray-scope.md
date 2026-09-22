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

Two situations intentionally leave the entry showing the disabled (·) state:

- Development (`npm run dev`) does not write a registry entry because the launch command is not a
  stable executable.
- The portable build runs from a temporary extraction directory, so its resolved path cannot be a
  stable Run entry. The toggle is reported as disabled; if you need startup behavior for the
  portable build, copy the executable (or the installer build) to a permanent location and point a
  Run entry at it manually.

Auto start launches the tray application with its default settings; it does not open the admin UI.
