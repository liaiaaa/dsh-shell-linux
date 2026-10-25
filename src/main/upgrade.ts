/**
 * One-click DSH upgrade: decide whether this install is user-writable, then run the npm global
 * install that updates it. The version check lives in `updates.ts`; this module only executes what
 * that check reported (the dist-tag was already chosen there).
 *
 * Why "in place" needs a probe: npm writes to `$(npm config get prefix)/lib/node_modules`, so a
 * plain `npm i -g` install (`~/.local`) can be updated by the shell, while a root-owned
 * `/usr/local` install cannot unless the user runs the command with sudo. The shell never escalates
 * privileges — it offers the command instead.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { installAnchor, installedDshVersion } from '../shared/config.ts'
import { redactTokens } from './redact.ts'
import { upgradeCommandForTag } from './updates.ts'

/** Set to `1` to report the command without running npm (probe/验收用). */
export const UPGRADE_DRY_RUN_ENV = 'DSH_DESKTOP_UPGRADE_DRY_RUN'
/** Override the npm executable (PATH lookup by default). */
export const NPM_OVERRIDE_ENV = 'DSH_DESKTOP_NPM'
/** How many log lines the window keeps (and the IPC state carries). */
export const MAX_UPGRADE_LOG_LINES = 200
const UPGRADE_TIMEOUT_MS = 600_000

/**
 * The npm global prefix that owns an install anchor.
 *
 * @param anchor - path to the installed DSH's own `package.json`
 *   (`<prefix>/lib/node_modules/@deepseek-ai/dsh/package.json`).
 * @returns `<prefix>`.
 */
export function npmPrefixFromAnchor(anchor: string): string {
  // package.json → dsh → @deepseek-ai → node_modules → lib → <prefix>
  let prefix = anchor
  for (let level = 0; level < 5; level += 1) prefix = dirname(prefix)
  return prefix
}

/**
 * Whether a global install under `prefix` is writable by this user.
 *
 * @param prefix - npm global prefix (`~/.local`, `/usr/local`, …).
 * @param access - injected for tests; must throw when the path is not writable.
 */
export function canUpgradeInPlace(
  prefix: string,
  access: (path: string) => void = (path) => { accessSync(path, constants.W_OK) },
): boolean {
  try {
    access(prefix)
    access(join(prefix, 'lib', 'node_modules'))
    return true
  } catch {
    return false
  }
}

export type UpgradeInvocation = { file: string; args: string[]; display: string }

/** The exact command line the shell would run to install the tag. */
export function upgradeInvocation(tag: 'latest' | 'next', npm: string = process.env[NPM_OVERRIDE_ENV] ?? 'npm'): UpgradeInvocation {
  return {
    file: npm,
    args: ['install', '-g', `@deepseek-ai/dsh@${tag}`],
    display: upgradeCommandForTag(tag),
  }
}

export type UpgradeResult =
  | { status: 'dry-run'; command: string; log: string[] }
  | { status: 'ok'; versionBefore: string; versionAfter: string; log: string[] }
  | { status: 'failed'; reason: string; log: string[] }

export type UpgradeOptions = {
  tag: 'latest' | 'next'
  /** Install anchor package.json; defaults to the resolved system install. */
  anchor?: string
  environment?: NodeJS.ProcessEnv
  /** One already-masked log line, for live display. */
  onLine?: (line: string) => void
  /** Injected for tests. */
  spawnImpl?: typeof spawn
  timeoutMs?: number
  /** Abort to stop the npm child (the install may be left incomplete; the UI says so). */
  signal?: AbortSignal
}

function installedVersionOrEmpty(): string {
  try {
    return installedDshVersion()
  } catch {
    return ''
  }
}

/**
 * Run the upgrade and report what happened.
 *
 * Resolves (never rejects) so the window can always render an outcome: `ok` carries the versions
 * read before and after the install, `failed` carries the reason and the log tail.
 */
export async function runUpgrade(options: UpgradeOptions): Promise<UpgradeResult> {
  const environment = options.environment ?? process.env
  const timeoutMs = options.timeoutMs ?? UPGRADE_TIMEOUT_MS
  const versionBefore = installedVersionOrEmpty()
  const invocation = upgradeInvocation(options.tag, environment[NPM_OVERRIDE_ENV] ?? 'npm')
  const log: string[] = []
  const push = (raw: string): void => {
    for (const line of redactTokens(raw).split('\n')) {
      if (line === '') continue
      log.push(line)
      if (log.length > MAX_UPGRADE_LOG_LINES) log.shift()
      options.onLine?.(line)
    }
  }

  if (environment[UPGRADE_DRY_RUN_ENV] === '1') {
    push(`# 演练模式（${UPGRADE_DRY_RUN_ENV}=1）：将执行 ${invocation.display}`)
    return { status: 'dry-run', command: invocation.display, log }
  }

  const spawnImpl = options.spawnImpl ?? spawn
  const child: ChildProcess = spawnImpl(invocation.file, invocation.args, {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  const pending = { stdout: '', stderr: '' }
  const wire = (stream: 'stdout' | 'stderr', chunk: string): void => {
    pending[stream] += chunk
    const lines = pending[stream].split('\n')
    pending[stream] = lines.pop() ?? ''
    for (const line of lines) push(line)
  }
  child.stdout?.on('data', (chunk: string) => { wire('stdout', chunk) })
  child.stderr?.on('data', (chunk: string) => { wire('stderr', chunk) })

  const stopOnAbort = (): void => { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  if (options.signal?.aborted === true) stopOnAbort()
  options.signal?.addEventListener('abort', stopOnAbort, { once: true })

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error; timedOut: boolean }>((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      // Resolve here as well: a child that ignores SIGTERM must not hang the window forever.
      resolve({ code: null, signal: null, timedOut: true })
    }, timeoutMs)
    timer.unref()
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stopOnAbort)
      resolve({ ...value, timedOut })
    }
    child.once('error', (error: Error) => { finish({ code: null, signal: null, error }) })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => { finish({ code, signal }) })
  })

  if (pending.stdout !== '') push(pending.stdout)
  if (pending.stderr !== '') push(pending.stderr)

  if (outcome.error !== undefined) return { status: 'failed', reason: outcome.error.message, log }
  if (outcome.timedOut) return { status: 'failed', reason: `npm 在 ${String(Math.round(timeoutMs / 60_000))} 分钟内没有结束`, log }
  if (outcome.code !== 0) return { status: 'failed', reason: `npm 退出码 ${String(outcome.code ?? outcome.signal)}`, log }
  return { status: 'ok', versionBefore, versionAfter: installedVersionOrEmpty(), log }
}
