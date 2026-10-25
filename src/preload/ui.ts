/**
 * Preload for the shell's own data: windows (About, startup failure).
 *
 * The pages have no Node access; this bridge is the only way their buttons reach the main process.
 * Every exposed function maps one-to-one onto a channel in `ABOUT_IPC`.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { ABOUT_IPC, type AboutUpdateState } from '../shared/about-ipc.ts'

const api = {
  check: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.check) as Promise<boolean>,
  upgrade: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.upgrade) as Promise<boolean>,
  cancelUpgrade: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.cancelUpgrade) as Promise<boolean>,
  relaunch: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.relaunch) as Promise<boolean>,
  copySummary: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.copySummary) as Promise<boolean>,
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.copyText, text) as Promise<boolean>,
  openRepo: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.openRepo) as Promise<boolean>,
  startSafeMode: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.startSafeMode) as Promise<boolean>,
  close: (): Promise<boolean> => ipcRenderer.invoke(ABOUT_IPC.close) as Promise<boolean>,
  /** Subscribe to update-state pushes; returns an unsubscribe function. */
  onState: (listener: (state: AboutUpdateState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AboutUpdateState): void => { listener(state) }
    ipcRenderer.on(ABOUT_IPC.state, handler)
    return () => { ipcRenderer.removeListener(ABOUT_IPC.state, handler) }
  },
}

contextBridge.exposeInMainWorld('dshUI', api)

export type ShellUiBridge = typeof api
