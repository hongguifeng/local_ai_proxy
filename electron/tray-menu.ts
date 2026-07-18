export type TrayMenuItem =
  { readonly click: () => void; readonly label: string } | { readonly type: "separator" };

export interface TrayOpenActions<TMenu> {
  on(event: "click" | "double-click", listener: () => void): unknown;
  setContextMenu(menu: TMenu): unknown;
}

export function installOpenAdminActions<TMenu>(
  tray: TrayOpenActions<TMenu>,
  buildMenu: (template: readonly TrayMenuItem[]) => TMenu,
  openAdmin: () => void,
  exit: () => Promise<void>,
): void {
  tray.setContextMenu(
    buildMenu([
      {
        label: "Open Admin UI",
        click: openAdmin,
      },
      { type: "separator" },
      {
        label: "Exit",
        click: () => {
          void exit();
        },
      },
    ]),
  );
  tray.on("click", openAdmin);
  tray.on("double-click", openAdmin);
}
