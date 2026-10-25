/**
 * IPC surface shared by the shell's own windows and their preload.
 *
 * The About window and the startup-failure window are `data:` URLs with no Node access, so every
 * action goes through these channels. The main process validates the sender before doing anything;
 * this module only names the channels so main and preload cannot drift apart.
 */

export const ABOUT_IPC = {
  /** main → window: the current update state. */
  state: 'dsh-shell-linux:about:state',
  check: 'dsh-shell-linux:about:check',
  upgrade: 'dsh-shell-linux:about:upgrade',
  cancelUpgrade: 'dsh-shell-linux:about:cancel-upgrade',
  relaunch: 'dsh-shell-linux:about:relaunch',
  copySummary: 'dsh-shell-linux:about:copy-summary',
  copyText: 'dsh-shell-linux:about:copy-text',
  openRepo: 'dsh-shell-linux:about:open-repo',
  startSafeMode: 'dsh-shell-linux:shell:start-safe-mode',
  close: 'dsh-shell-linux:shell:close',
} as const

export type AboutUpdateChannel = 'latest' | 'next'

/**
 * What the About window's update section is showing.
 *
 * `log` is always present so a new state never accidentally hides the lines already printed; it is
 * capped to the last 200 lines by the main process.
 */
export type AboutUpdateState =
  | { kind: 'idle'; log: string[] }
  | { kind: 'checking'; log: string[] }
  | { kind: 'latest'; version: string; channel: AboutUpdateChannel; log: string[] }
  | { kind: 'available'; version: string; channel: AboutUpdateChannel; canUpgrade: boolean; command: string; log: string[] }
  | { kind: 'unreachable'; reason: string; log: string[] }
  | { kind: 'error'; reason: string; log: string[] }
  | { kind: 'upgrading'; log: string[] }
  | { kind: 'upgraded'; version: string; log: string[] }
  | { kind: 'dry-run'; command: string; log: string[] }
