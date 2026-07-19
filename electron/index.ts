import { app, dialog, Menu, nativeImage, shell, Tray } from "electron";

import { createNodeApplication } from "../src/app/index.js";
import { shutdownAndQuit } from "./exit.js";
import { startHeadlessElectronMain } from "./headless-main.js";
import { installSmokeExitSignal } from "./smoke-exit.js";
import { resolveTrayIconPath } from "./tray-icon.js";
import { installOpenAdminActions } from "./tray-menu.js";
import { parseTrayOptions } from "./tray-options.js";
import { showStartupError } from "./startup-error.js";
import { configureSingleInstance } from "./single-instance.js";
import { configureElectronUserData } from "./user-data.js";

let tray: Tray | undefined;
let openAdmin = (): void => undefined;

const dataDirectory = configureElectronUserData(app);
if (configureSingleInstance(app, () => openAdmin())) {
  void start().catch((error: unknown) => {
    showStartupError(error, dialog, process.env);
    app.quit();
  });
}

async function start(): Promise<void> {
  await startHeadlessElectronMain(app);
  const trayOptions = await parseTrayOptions(
    process.argv.slice(app.isPackaged ? 1 : 2),
    process.env,
    dataDirectory,
  );
  const options = trayOptions.cli;
  const runtime = createNodeApplication({ ...options, version: app.getVersion() });
  installSmokeExitSignal(process.env["LLM_PROXY_SMOKE_EXIT_FILE"], () =>
    shutdownAndQuit(runtime.application, app),
  );
  await runtime.application.start();
  const adminPort = runtime.address()?.port ?? options.port;
  const adminUrl = `http://${options.host}:${adminPort}`;
  openAdmin = () => {
    void shell.openExternal(adminUrl);
  };
  const trayIcon = nativeImage.createFromPath(
    resolveTrayIconPath(app.isPackaged, process.resourcesPath),
  );
  if (trayIcon.isEmpty()) {
    throw new Error("The packaged tray icon could not be loaded.");
  }
  tray = new Tray(trayIcon);
  tray.setToolTip("LLM Proxy");
  installOpenAdminActions(
    tray,
    (template) => Menu.buildFromTemplate([...template]),
    openAdmin,
    () => shutdownAndQuit(runtime.application, app),
  );
  if (trayOptions.openOnStart) openAdmin();
}
