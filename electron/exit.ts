import type { Application } from "../src/app/index.js";

export interface ElectronQuitter {
  quit(): void;
}

export async function shutdownAndQuit(
  application: Application,
  electron: ElectronQuitter,
): Promise<void> {
  await application.stop();
  electron.quit();
}
