# Windows Tray Scope

The Windows tray application starts only when the user launches it. This refactor does not register
the application for Windows login startup and does not call Electron's `setLoginItemSettings` API.
Users can add startup behavior manually after installation if their deployment requires it.
