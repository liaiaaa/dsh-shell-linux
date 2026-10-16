/** IPC channel names and the host→shell event contract. */

export const SCHEME = 'dsh-app'

export const DESKTOP_IPC = {
  boot: 'desktop:boot',
  bootFailed: 'desktop:boot-failed',
  directoryPick: 'desktop:directory-pick',
  windowControl: 'desktop:window-control',
  windowState: 'desktop:window-state',
  menuPopup: 'desktop:menu-popup',
  shortcutsGet: 'desktop:shortcuts-get',
  shortcutsEdit: 'desktop:shortcuts-edit',
  shortcutsChanged: 'desktop:shortcuts-changed',
  shortcutsRecording: 'desktop:shortcuts-recording',
} as const

export interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[]
}

export interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  readonly diagnostic?: string
}

/** Shell request: open an attempt's authorization page, or settle it once it ended. */
export type PlatformLoginRequest =
  | { readonly action: 'open'; readonly url: string }
  | { readonly action: 'close'; readonly focus: boolean }

export interface PlatformLoginEvent {
  readonly type: 'platform-login'
  readonly request: PlatformLoginRequest
}

export type ShutdownCompleteEvent = { readonly type: 'shutdown-complete' }

export type HostEvent = ReadyEvent | FatalEvent | PlatformLoginEvent | ShutdownCompleteEvent

export function isHostEvent(message: unknown): message is HostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'ready':
      return typeof candidate.url === 'string' && candidate.url.length > 0
        && (candidate.injections === undefined || Array.isArray(candidate.injections))
    case 'fatal':
      return typeof candidate.message === 'string'
        && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'platform-login': {
      const request = candidate.request
      if (typeof request !== 'object' || request === null || !('action' in request)) return false
      if (request.action === 'open') return typeof (request as { url?: unknown }).url === 'string'
      if (request.action === 'close') return typeof (request as { focus?: unknown }).focus === 'boolean'
      return false
    }
    case 'shutdown-complete':
      return true
    default:
      return false
  }
}
