/**
 * Desktop keyboard bridge (the `dshDesktop.keyboard` half of the dsh-client-shortcuts contract).
 * Structure follows anywhere-labs/dsh-desktop dsh-desktop-next/src/preload-keyboard.ts (MIT).
 *
 * Linux dispatches shortcuts through the DOM; the bridge only has to exist for the runtime to
 * report 'desktop' — and `closeWindow` is what the frontend's `page.close` command (Ctrl+W)
 * falls back to when no closable panel has focus. The old shell stubbed it as a no-op, so the
 * key was consumed and nothing happened; forwarding to the window-control channel makes Ctrl+W
 * close the window exactly like the caption bar's close button (same IPC, same sender checks).
 */
import type { IpcRenderer, IpcRendererEvent } from 'electron'
import { DESKTOP_IPC } from '../shared/ipc.ts'

export interface DesktopShortcutInput {
  readonly kind: string
  readonly frameName?: string
  readonly [key: string]: unknown
}

export function createDesktopKeyboardBridge(
  send: IpcRenderer['send'],
  subscribeOn: (channel: string, handler: (event: IpcRendererEvent, input: DesktopShortcutInput) => void) => () => void,
): {
  subscribe: (listener: (input: DesktopShortcutInput) => void) => () => void
  closeWindow: (revision: unknown) => Promise<void>
} {
  return {
    // Native input forwarding is a desktop-native concern; on Linux the DOM feeds the
    // registry directly, so no listener is ever invoked — but the subscription surface
    // must behave like the real bridge (register once, dispose cleanly).
    subscribe: (listener) => subscribeOn('desktop:shortcuts-input', (_event, input) => { listener(input) }),
    closeWindow: async (_revision) => { send(DESKTOP_IPC.windowControl, 'close') },
  }
}
