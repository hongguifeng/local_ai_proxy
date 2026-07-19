export interface HeadlessElectronApp {
  on(event: "window-all-closed", listener: () => void): unknown;
  whenReady(): Promise<void>;
}

export async function startHeadlessElectronMain(app: HeadlessElectronApp): Promise<void> {
  app.on("window-all-closed", () => {
    // The tray owns the application lifetime; closing incidental windows must not quit it.
  });
  await app.whenReady();
}
