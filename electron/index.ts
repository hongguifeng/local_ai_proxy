import { app, Menu, nativeImage, shell, Tray } from "electron";

import { createNodeApplication } from "../src/app/index.js";
import { parseCliArgs } from "../src/cli/index.js";
import { shutdownAndQuit } from "./exit.js";
import { startHeadlessElectronMain } from "./headless-main.js";
import { TRAY_ICON_DATA_URL } from "./tray-icon.js";
import { installOpenAdminActions } from "./tray-menu.js";

await startHeadlessElectronMain(app);
const options = parseCliArgs(process.argv.slice(app.isPackaged ? 1 : 2));
const runtime = createNodeApplication({ ...options, version: app.getVersion() });
await runtime.application.start();
const adminPort = runtime.address()?.port ?? options.port;
const adminUrl = `http://${options.host}:${adminPort}`;
const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
tray.setToolTip("LLM Proxy");
installOpenAdminActions(
  tray,
  (template) => Menu.buildFromTemplate([...template]),
  () => {
    void shell.openExternal(adminUrl);
  },
  () => shutdownAndQuit(runtime.application, app),
);
