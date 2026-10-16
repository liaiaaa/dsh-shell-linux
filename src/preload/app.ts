/**
 * dsh-shell-linux preload: origin-scoped desktop bridges for the user's web profile.
 * Structure follows deepseek-ai/deepseek-harness apps/desktop/src/preload-app.ts (MIT).
 * Keyboard stays a minimal bridge: Linux dispatches shortcuts through the DOM
 * (dsh-client-shortcuts only needs the bridge to exist when data-platform is set).
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_IPC, SCHEME } from '../shared/ipc.ts'
import { createDesktopKeyboardBridge } from './keyboard.ts'

const onAppOrigin = location.protocol === `${SCHEME}:` && location.hostname === 'app' && process.isMainFrame

// dsh-client-shortcuts: data-platform implies runtime 'desktop' and requires the bridge to exist.
// A preload runs at document_start, before the parser has created the document root, so the mark
// defers to DOMContentLoaded when `documentElement` is still null (upstream preload-platform.ts).
const markDocumentPlatform = (): void => {
  const mark = (): void => { document.documentElement.dataset.platform = process.platform }
  // lib.dom types documentElement non-null, but a preload runs before the document root exists.
  const root = document.documentElement as HTMLElement | null
  if (root === null) window.addEventListener('DOMContentLoaded', mark, { once: true })
  else mark()
}
markDocumentPlatform()

if (onAppOrigin) {
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot),
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message),
  })
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick),
  })
  // Dropped/picked files with a real path become `@path` citations instead of uploads.
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor: (file: File) => webUtils.getPathForFile(file),
  })
  // The window runs frameless; the in-page caption bar drives these controls.
  // `sendSync` is deliberate for the state query: the page needs the current
  // maximized flag synchronously when it first paints the caption.
  contextBridge.exposeInMainWorld('dshDesktopWindow', {
    minimize: () => ipcRenderer.send(DESKTOP_IPC.windowControl, 'minimize'),
    toggleMaximize: () => ipcRenderer.send(DESKTOP_IPC.windowControl, 'maximize'),
    close: () => ipcRenderer.send(DESKTOP_IPC.windowControl, 'close'),
    isMaximized: () => ipcRenderer.sendSync(DESKTOP_IPC.windowControl, 'maximized-state') as boolean,
    // In-page caption menus: opens a native menu at the clicked button's viewport
    // coordinates; the promise settles when that menu closes.
    popupMenu: (name: string, x: number, y: number) => ipcRenderer.invoke(DESKTOP_IPC.menuPopup, name, x, y),
    // Settled maximized-state push (the WM applies maximize asynchronously; a read right
    // after toggleMaximize may observe the stale value).
    onMaximizedChanged: (listener: (maximized: boolean) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, maximized: unknown): void => { if (typeof maximized === 'boolean') listener(maximized) }
      ipcRenderer.on(DESKTOP_IPC.windowState, wrapped)
      return () => { ipcRenderer.off(DESKTOP_IPC.windowState, wrapped) }
    },
  })
  // Shortcut-preference persistence for the settings editor (get/edit/subscribe/recording
  // of the dsh-client-shortcuts desktop contract). Snapshots are opaque validated objects.
  contextBridge.exposeInMainWorld('dshDesktop', {
    protocolVersion: 1,
    keyboard: createDesktopKeyboardBridge(
      (channel, ...args) => ipcRenderer.send(channel, ...args),
      (channel, handler) => {
        const wrapped = (event: Electron.IpcRendererEvent, input: unknown): void => handler(event, input as never)
        ipcRenderer.on(channel, wrapped)
        return () => { ipcRenderer.off(channel, wrapped) }
      },
    ),
    shortcuts: {
      get: (definitions: unknown) => ipcRenderer.invoke(DESKTOP_IPC.shortcutsGet, definitions),
      edit: (edit: unknown, revision: string) => ipcRenderer.invoke(DESKTOP_IPC.shortcutsEdit, edit, revision),
      subscribe: (listener: (snapshot: unknown) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => listener(snapshot)
        ipcRenderer.on(DESKTOP_IPC.shortcutsChanged, wrapped)
        return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsChanged, wrapped) }
      },
      recording: (active: boolean) => ipcRenderer.send(DESKTOP_IPC.shortcutsRecording, active),
    },
  })
}
