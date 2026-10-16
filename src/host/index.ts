/** Boot the user's `web` profile in this Node-mode child and report its URL to the shell. */
import { createRequire } from 'node:module'
import { inspect } from 'node:util'
import { installAnchor } from '../shared/config.ts'
import { watchPlatformLogin, type PlatformLoginAccount } from './platform-login.ts'

const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error: Error | null) => { if (error === null) resolve(); else reject(error) })
  })
}

/**
 * IPC send whose rejection can never surface as an unhandled rejection. DSH installs
 * fail-loud handling, so a rejected send left unhandled would exit the host. Returned
 * (rather than swallowed here) so the one caller that must not disconnect before the
 * message is flushed can still await it.
 */
const sendSafely = (message: object): Promise<void> => send(message).catch(() => {})

async function main(): Promise<void> {
  const profileDir = process.argv[2]
  if (profileDir === undefined) throw new Error('usage: host <profile-dir>')
  const anchor = installAnchor()
  const anchorRequire = createRequire(anchor)
  const bootModule = await import(anchorRequire.resolve('@deepseek-ai/dsh-app-boot'))
  const profileBootModule = await import(anchorRequire.resolve('@deepseek-ai/dsh/profile-boot'))
  const { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } = bootModule as {
    loadLayeredEnv: (binName: string) => NodeJS.ProcessEnv
    loadProfileDirectory: (binName: string, dir: string, installAnchor: string) => {
      name: string; layers: { packageName: string }[]; patches: unknown[]; skippedBundles: { packageName: string; reason: string }[]
    }
    reportSkippedBundles: (binName: string, profile: unknown) => void
  }
  const { runProfile } = profileBootModule as {
    runProfile: (options: Record<string, unknown>) => Promise<{ ctx: Record<string, any>; shutdown: { shutdown(code: number): Promise<void> } }>
  }

  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  reportSkippedBundles('dsh', profile)
  if (process.env.DSH_HOST_DEBUG !== undefined) {
    console.error('[host] bundles:', profile.layers.map(layer => layer.packageName).join(', '))
    console.error('[host] user patch rows loaded:', profile.patches.length)
    console.error('[host] skipped bundles:', JSON.stringify(profile.skippedBundles))
  }

  // The shell's own overlay (cap the account plugin's platform timeouts), written by the
  // main process into the shell's userData. Overlays are applied after the user's own
  // patch layer, so this can cap the timeouts regardless of the user's config. Absent
  // (e.g. host run standalone) simply means no overlay.
  const shellPatch = process.env.DSH_DESKTOP_HOST_PATCH
  const patchFiles = shellPatch === undefined || shellPatch === '' ? [] : [shellPatch]

  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    resolvedProfile: { profile, installAnchor: anchor },
    patchFiles,
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
  })

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    // Awaited, not fire-and-forget: the message must be flushed before the disconnect below.
    await sendSafely({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as { type?: string }).type === 'shutdown') void stop().catch(() => {})
  })
  process.once('disconnect', () => { void stop().catch(() => {}) })

  const { ctx } = await application
  const webServer = ctx.get('webServer') as { host: string; port: number }
  const connection = ctx.get('connection') as { authenticatedUrl(baseUrl: string): string }
  const url = connection.authenticatedUrl(`http://${webServer.host}:${String(webServer.port)}`)
  if (process.env.DSH_HOST_DEBUG !== undefined) {
    const requestLog = url.replace(/\?.*$/, '')
    console.error('[host] ready url origin+path (token omitted):', requestLog)
  }
  const account = (() => { try { return ctx.get('deepseekAccount') as PlatformLoginAccount | undefined } catch { return undefined } })()
  // The shell ships a 3s cap on the account plugin's platform timeouts (overlay-patch.ts).
  // Whether that overlay actually reached the plugin is otherwise invisible, and a silent no-op
  // means a stalled platform call still holds `session/create` for the plugin's 30s default.
  // Print what the mounted service really uses; private fields are read through a widening cast
  // because the public type only exposes watch().
  if (process.env.DSH_HOST_DEBUG !== undefined) {
    const live = account as unknown as { requestTimeout?: number, balanceTimeout?: number } | undefined
    console.error('[host] account timeouts in effect (ms):', JSON.stringify({
      requestTimeout: live?.requestTimeout, balanceTimeout: live?.balanceTimeout,
    }))
  }
  if (account === undefined) {
    console.error('[dsh-shell-linux] deepseekAccount service is not mounted; shell-open for sign-in is disabled')
  } else {
    void watchPlatformLogin(account, (request) => {
      void send({ type: 'platform-login', request }).catch((error: unknown) => {
        console.error('[dsh-shell-linux] platform-login send failed:', error)
      })
    }, new AbortController().signal).catch((error: unknown) => {
      console.error('[dsh-shell-linux] account watch failed:', error)
    })
  }
  const injections = (ctx as { webServer: { collectIndexInjections(): unknown[] } }).webServer.collectIndexInjections()
  await send({ type: 'ready', url, injections })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    void sendSafely({ type: 'fatal', message, diagnostic })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
