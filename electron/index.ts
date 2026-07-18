import { app } from "electron";

import { startHeadlessElectronMain } from "./headless-main.js";

await startHeadlessElectronMain(app);
