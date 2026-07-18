import { app, nativeImage, Tray } from "electron";

import { startHeadlessElectronMain } from "./headless-main.js";
import { TRAY_ICON_DATA_URL } from "./tray-icon.js";

await startHeadlessElectronMain(app);
const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
tray.setToolTip("LLM Proxy");
