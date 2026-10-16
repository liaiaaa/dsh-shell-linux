/**
 * Shared menu templates: the hidden application menu and the in-page caption popups.
 *
 * Both come from this module so labels, accelerators, and separators cannot drift apart.
 * Only `electron`'s *types* are imported (erased at compile time), which keeps this file
 * unit-testable without an Electron runtime.
 */
import type { MenuItemConstructorOptions } from 'electron'

export type PopupMenuName = 'file' | 'help'

export interface MenuActions {
  readonly checkForUpdates: () => void
  readonly showAbout: () => void
}

const POPUP_MENU_NAMES: readonly PopupMenuName[] = ['file', 'help']

export function isPopupMenuName(value: unknown): value is PopupMenuName {
  return typeof value === 'string' && (POPUP_MENU_NAMES as readonly string[]).includes(value)
}

/**
 * The hidden application menu. The menu bar is never shown (autoHideMenuBar +
 * setMenuBarVisibility(false)); its accelerators are the only reason it stays mounted,
 * so F1 and Ctrl+Shift+U keep working globally.
 */
export function buildApplicationMenuTemplate(actions: MenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'DSH',
      submenu: [
        { label: '关于 dsh-shell-linux', accelerator: 'F1', click: actions.showAbout },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查 DSH 更新…', accelerator: 'Ctrl+Shift+U', click: actions.checkForUpdates },
      ],
    },
  ]
}

/**
 * Popup items for the in-page caption menus.
 *
 * `registerAccelerator: false` keeps the shortcut hint visible while the application menu
 * remains the sole owner of the global accelerator — without it, F1 would fire the About
 * dialog twice (once for the popup item, once for the application menu item).
 */
export function buildPopupMenuTemplate(name: PopupMenuName, actions: MenuActions): MenuItemConstructorOptions[] {
  if (name === 'file') {
    return [
      { label: '检查 DSH 更新…', accelerator: 'Ctrl+Shift+U', registerAccelerator: false, click: actions.checkForUpdates },
      { type: 'separator' },
      { role: 'quit', label: '退出' },
    ]
  }
  return [
    { label: '关于 dsh-shell-linux', accelerator: 'F1', registerAccelerator: false, click: actions.showAbout },
  ]
}

/**
 * Validate one caption-supplied coordinate. Kept separate from `resolvePopupRequest` so the
 * narrowing applies to the returned value: a `for…of` over a tuple narrows only the loop
 * variable, which left `x`/`y` as `unknown` at the return site (caught by `tsc`, not by the
 * esbuild-only check).
 */
function popupCoordinate(label: 'x' | 'y', value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new Error(`invalid popup coordinate ${label}: ${String(value)}`)
  }
  return value
}

/**
 * Validate an untrusted popup request from the renderer. The caption sends viewport
 * coordinates of the clicked button; anything non-finite or out of range is a bug or a
 * hostile frame, so it throws rather than reaching `Menu.popup`.
 */
export function resolvePopupRequest(
  name: unknown,
  x: unknown,
  y: unknown,
): { name: PopupMenuName; x: number; y: number } {
  if (!isPopupMenuName(name)) throw new Error(`unknown popup menu: ${String(name)}`)
  return { name, x: popupCoordinate('x', x), y: popupCoordinate('y', y) }
}