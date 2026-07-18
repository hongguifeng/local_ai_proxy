import { app, Menu, nativeImage, shell, Tray } from "electron";

import { createNodeApplication } from "../src/app/index.js";
import { shutdownAndQuit } from "./exit.js";
import { startHeadlessElectronMain } from "./headless-main.js";
import { TRAY_ICON_DATA_URL } from "./tray-icon.js";
import { installOpenAdminActions } from "./tray-menu.js";
import { parseTrayOptions } from "./tray-options.js";

await startHeadlessElectronMain(app);
const trayOptions = parseTrayOptions(process.argv.slice(app.isPackaged ? 1 : 2));
const options = trayOptions.cli;
const runtime = createNodeApplication({ ...options, version: app.getVersion() });
await runtime.application.start();
const adminPort = runtime.address()?.port ?? options.port;
const adminUrl = `http://${options.host}:${adminPort}`;
const openAdmin = () => {
  void shell.openExternal(adminUrl);
};
const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
tray.setToolTip("LLM Proxy");
installOpenAdminActions(
  tray,
  (template) => Menu.buildFromTemplate([...template]),
  openAdmin,
  () => shutdownAndQuit(runtime.application, app),
);
if (trayOptions.openOnStart) openAdmin();
