/**
 * The About window: one BrowserWindow showing `aboutDocument()`, refreshed by pushed update states.
 *
 * The window is a `data:` URL with the shell's UI preload; it never gets Node access. Window
 * lifetime is the module's own concern so the menu, F1, and the update check all share one instance.
 */
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { ABOUT_IPC, type AboutUpdateState } from '../shared/about-ipc.ts'
import { aboutDocument, type AboutProps } from './about-document.ts'

export type AboutWindowOptions = {
  /** Current versions and mode; called on every open. */
  props: () => AboutProps
  iconPath: string
  preloadPath: string
}

export type AboutWindowHandle = {
  show: () => void
  refresh: (state: AboutUpdateState) => void
  close: () => void
  browserWindow: () => BrowserWindow | undefined
}

/**
 * Create the About window controller. No window exists until `show()` is called.
 *
 * @returns handlers the main process wires into its menu actions and update state machine.
 */
export function createAboutWindow(options: AboutWindowOptions): AboutWindowHandle {
  let window: BrowserWindow | undefined
  let lastState: AboutUpdateState = { kind: 'idle', log: [] }

  const show = (): void => {
    if (window !== undefined && !window.isDestroyed()) {
      window.show()
      window.focus()
      return
    }
    const created = new BrowserWindow({
      width: 560,
      height: 660,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      show: false,
      title: '关于 dsh-shell-linux',
      icon: options.iconPath,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#f6f6f6',
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    window = created
    created.once('ready-to-show', () => { created.show() })
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // The page's only load is its own data: URL; anything else is a stray navigation.
    created.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('data:')) return
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    })
    created.webContents.on('did-finish-load', () => {
      created.webContents.send(ABOUT_IPC.state, lastState)
    })
    created.on('closed', () => {
      if (window === created) window = undefined
    })
    const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(aboutDocument({ ...options.props(), update: lastState }))}`
    void created.loadURL(documentUrl)
  }

  const refresh = (state: AboutUpdateState): void => {
    lastState = state
    if (window !== undefined && !window.isDestroyed()) window.webContents.send(ABOUT_IPC.state, state)
  }

  const close = (): void => {
    if (window !== undefined && !window.isDestroyed()) window.close()
  }

  return { show, refresh, close, browserWindow: () => window }
}
