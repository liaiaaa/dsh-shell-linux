/**
 * The shell's own `--patch` overlay for the user's profile.
 *
 * What it does: the DeepSeek account plugin (entry id `deepseek-account`) defaults both
 * platform timeouts to 30s (`Config.requestTimeoutMs` / `balanceTimeoutMs`), which is a long
 * time to stare at "载入历史". The shell cannot patch the installed core (root-owned prefix), but
 * `runProfile` accepts overlay files applied AFTER the user's own patch layer, so the cap holds
 * regardless of the user's config; the plugin already degrades to "no account figures" on failure.
 *
 * HONEST SCOPE (do not re-claim more than this): the measured stall is NOT a timeout
 * this cap can cut. The account request died at +42.9s / +47.5s WITH the 3s overlay applied,
 * because the wait is a connect that had already succeeded and was awaiting the response — not
 * interruptible from here. The stall is addressed by routing the host through the system proxy
 * (`src/main/system-proxy.ts`); this file stays as a cheap second layer so a plain platform
 * timeout costs 3s instead of 30s.
 *
 * Deliberately narrow: only the two request timeouts are set, nothing else. The file is
 * written into the shell's OWN userData (never into `~/.dsh/`), and only when the
 * caller asks for it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Entry id the account plugin mounts under (dsh-base/cordis.patch.yml). */
export const ACCOUNT_ENTRY_ID = 'deepseek-account'

/** Fail-fast ceiling for the account plugin's platform calls, in milliseconds. */
export const ACCOUNT_TIMEOUT_MS = 3_000

/** YAML for the overlay. Kept as text so it can be written verbatim and read in tests. */
export function overlayPatchYaml(timeoutMs: number = ACCOUNT_TIMEOUT_MS): string {
  return [
    `# dsh-shell-linux: cap the account plugin's platform timeouts so a stalled`,
    `# platform.deepseek.com request cannot hold session opening behind it.`,
    `- id: ${ACCOUNT_ENTRY_ID}`,
    `  config:`,
    `    requestTimeoutMs: ${String(timeoutMs)}`,
    `    balanceTimeoutMs: ${String(timeoutMs)}`,
    '',
  ].join('\n')
}

/** Write the overlay to `path` (creating its directory) and return the path. */
export function writeOverlayPatch(path: string, timeoutMs: number = ACCOUNT_TIMEOUT_MS): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, overlayPatchYaml(timeoutMs))
  return path
}
