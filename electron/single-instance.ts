export interface SingleInstanceApp {
  on(event: "second-instance", listener: () => void): unknown;
  quit(): void;
  requestSingleInstanceLock(): boolean;
}

export function configureSingleInstance(app: SingleInstanceApp, activate: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", activate);
  return true;
}
