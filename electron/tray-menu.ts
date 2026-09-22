export type TrayMenuItem =
  | {
      readonly checked?: boolean;
      readonly click: () => void;
      readonly label: string;
      readonly type?: "checkbox";
    }
  | { readonly type: "separator" };

export interface TrayOpenActions<TMenu> {
  on(event: "click" | "double-click", listener: () => void): unknown;
  setContextMenu(menu: TMenu): unknown;
}

export interface AutoStartState {
  readonly autoStart: boolean;
}

export interface AutoStartControl {
  readonly state: AutoStartState;
  toggle(): Promise<void>;
}

export function installOpenAdminActions<TMenu>(
  tray: TrayOpenActions<TMenu>,
  buildMenu: (template: readonly TrayMenuItem[]) => TMenu,
  openAdmin: () => void,
  exit: () => Promise<void>,
  autoStart?: AutoStartControl,
): void {
  const installMenu = (): void => {
    const template: TrayMenuItem[] = [
      {
        label: "Open Admin UI",
        click: openAdmin,
      },
      { type: "separator" },
    ];
    if (autoStart !== undefined) {
      const enabled = autoStart.state.autoStart;
      // Windows tray menus render "checkbox" items as a plain square and ignore
      // the "checked" flag, so the current state is shown in the label instead.
      template.push({
        label: `${enabled ? "\u2713 " : "\u00B7 "}Start with Windows`,
        type: "checkbox",
        checked: enabled,
        click: () => {
          void autoStart.toggle().then(() => installMenu());
        },
      });
    }
    template.push({
      label: "Exit",
      click: () => {
        void exit();
      },
    });
    tray.setContextMenu(buildMenu(template));
  };
  installMenu();
  tray.on("click", openAdmin);
  tray.on("double-click", openAdmin);
}
