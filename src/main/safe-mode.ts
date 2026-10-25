/**
 * Safe mode: boot the host on a pristine profile seeded from the shipped `web` template.
 *
 * The official recovery path is `dsh <name> --from-default-profile web` — it replaces the named
 * custom profile with a fresh copy of the shipped template, so the boot carries no third-party
 * bundles and no user patch layer. The shell uses that exact CLI invocation (with `--dump-config`,
 * which seeds the profile and exits instead of serving) to prepare `profiles/rescue`, then points
 * its own host child at that directory.
 *
 * Red line 2 exception (decisions.md D17): this creates `~/.dsh/profiles/rescue` (four small files,
 * no dependencies). It never touches `profiles/web` or any pre-existing file under `~/.dsh`.
 */
import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Set to `1` to boot the host on the rescue profile. */
export const SAFE_MODE_ENV = 'DSH_DESKTOP_SAFE_MODE'
/** Command-line switch carrying the same request through `app.relaunch` (which cannot pass env). */
export const SAFE_MODE_FLAG = '--safe-mode'
/** Profile name of the pristine copy; also the CLI profile name used while seeding. */
export const SAFE_MODE_PROFILE = 'rescue'
/** Consecutive failed startups before the shell offers safe mode. */
export const SAFE_MODE_FAILURE_THRESHOLD = 2
export const STARTUP_STATE_FILE = 'startup-state.json'
const MAX_RECORDED_FAILURES = 9
const SEED_TIMEOUT_MS = 120_000
const SEED_TAIL_CHARS = 4000

/** `$DSH_HOME` when set, `~/.dsh` otherwise — the shell respects the same override DSH does. */
export function dshHome(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = environment.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(home, '.dsh')
}

/**
 * Whether this launch was asked for safe mode.
 *
 * Two carriers: the environment variable (for scripts and probes) and `--safe-mode` on the command
 * line, because `app.relaunch()` accepts arguments but no environment.
 */
export function safeModeRequested(environment: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(1)): boolean {
  return environment[SAFE_MODE_ENV] === '1' || argv.includes(SAFE_MODE_FLAG)
}

/** `<dshHome>/profiles/rescue`. */
export function safeModeProfileDir(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dshHome(environment, home), 'profiles', SAFE_MODE_PROFILE)
}

/**
 * The host child's profile directory.
 *
 * Precedence: explicit `DSH_DESKTOP_PROFILE`, then `profiles/rescue` in safe mode, then
 * `profiles/web`.
 */
export function profileDirFor(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = environment.DSH_DESKTOP_PROFILE
  if (override !== undefined && override !== '') return override
  const name = safeModeRequested(environment) ? SAFE_MODE_PROFILE : 'web'
  return join(dshHome(environment, home), 'profiles', name)
}

/** The profile name the host child passes to `runProfile`. */
export function profileNameFor(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = profileDirFor(environment, home)
  const name = dir.split(/[\\/]/).filter((part) => part !== '').pop()
  return name === undefined || name === '' ? 'web' : name
}

/**
 * Arguments for a relaunch in the given mode.
 *
 * `app.relaunch` replaces the whole argument list but cannot set the environment, so the mode
 * travels as `--safe-mode`; any stale copy of it is removed first so mode switching is idempotent.
 *
 * @param current - `process.argv.slice(1)` of this launch.
 */
export function relaunchArguments(current: readonly string[], mode: 'normal' | 'safe'): string[] {
  const args = current.filter((argument) => argument !== SAFE_MODE_FLAG)
  return mode === 'safe' ? [...args, SAFE_MODE_FLAG] : args
}

export type StartupState = { failures: number }

export function startupStatePath(userData: string): string {
  return join(userData, STARTUP_STATE_FILE)
}

/** The recorded consecutive-failure count; unreadable state counts as fresh. */
export function readStartupState(userData: string): StartupState {
  try {
    const raw: unknown = JSON.parse(readFileSync(startupStatePath(userData), 'utf8'))
    const failures = (raw as { failures?: unknown } | null)?.failures
    if (typeof failures !== 'number' || !Number.isFinite(failures) || failures < 0) return { failures: 0 }
    return { failures: Math.min(MAX_RECORDED_FAILURES, Math.floor(failures)) }
  } catch {
    return { failures: 0 }
  }
}

/** Count this startup attempt; the count is cleared once the host reports ready. */
export function recordStartupAttempt(userData: string): StartupState {
  const next: StartupState = { failures: Math.min(MAX_RECORDED_FAILURES, readStartupState(userData).failures + 1) }
  try {
    mkdirSync(userData, { recursive: true })
    writeFileSync(startupStatePath(userData), JSON.stringify(next), 'utf8')
  } catch { /* best effort: a full disk must not block startup */ }
  return next
}

/** A boot reached the host's `ready` event. */
export function clearStartupFailures(userData: string): void {
  try {
    writeFileSync(startupStatePath(userData), JSON.stringify({ failures: 0 } satisfies StartupState), 'utf8')
  } catch { /* best effort */ }
}

/** Whether the recorded failures are enough to offer safe mode. */
export function shouldSuggestSafeMode(failures: number): boolean {
  return failures >= SAFE_MODE_FAILURE_THRESHOLD
}

export type SeedInvocation = { file: string; args: string[] }

/**
 * The CLI call that seeds the rescue profile and exits.
 *
 * @param anchor - the installed DSH's own `package.json`; the CLI entry is `lib/bin.js` next to it.
 */
export function rescueSeedInvocation(anchor: string): SeedInvocation {
  return {
    file: join(dirname(anchor), 'lib', 'bin.js'),
    args: ['--profile', SAFE_MODE_PROFILE, '--from-default-profile', 'web', '--dump-config'],
  }
}

export type SeedResult = { status: 'ok' | 'skipped' | 'failed'; tail: string }

/**
 * Prepare `profiles/rescue` when it is absent.
 *
 * `skipped` when the profile is already there (the CLI replaces it destructively, so an existing
 * rescue profile is left alone); `failed` carries the CLI's output tail for the error window.
 */
export async function seedRescueProfile(options: {
  dshHome: string
  node: string
  anchor: string
  environment: NodeJS.ProcessEnv
  spawnImpl?: typeof spawn
  timeoutMs?: number
}): Promise<SeedResult> {
  const directory = join(options.dshHome, 'profiles', SAFE_MODE_PROFILE)
  if (existsSync(join(directory, 'package.json'))) return { status: 'skipped', tail: '' }
  const invocation = rescueSeedInvocation(options.anchor)
  const spawnImpl = options.spawnImpl ?? spawn
  const environment: NodeJS.ProcessEnv = { ...options.environment, DSH_HOME: options.dshHome }
  let tail = ''
  const append = (chunk: string): void => { tail = (tail + chunk).slice(-SEED_TAIL_CHARS) }
  let child: ChildProcess
  try {
    const spawnOptions: SpawnOptions = { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
    // node runs the CLI entry; the CLI path has to come first or node parses the flags itself
    // ("bad option: --profile" — observed on the first safe-mode probe).
    child = spawnImpl(options.node, [invocation.file, ...invocation.args], spawnOptions)
  } catch (error) {
    return { status: 'failed', tail: error instanceof Error ? error.message : String(error) }
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { append(chunk) })
  child.stderr?.on('data', (chunk: string) => { append(chunk) })
  const timeoutMs = options.timeoutMs ?? SEED_TIMEOUT_MS
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error; timedOut: boolean }>((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }, timeoutMs)
    timer.unref()
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void => {
      clearTimeout(timer)
      resolve({ ...value, timedOut })
    }
    child.once('error', (error: Error) => { finish({ code: null, signal: null, error }) })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => { finish({ code, signal }) })
  })
  if (outcome.error !== undefined) return { status: 'failed', tail: outcome.error.message }
  if (outcome.timedOut) return { status: 'failed', tail: `准备安全模式 profile 超时（${String(Math.round(timeoutMs / 1000))}s）\n${tail}` }
  if (outcome.code !== 0) return { status: 'failed', tail: `准备安全模式 profile 失败（退出码 ${String(outcome.code ?? outcome.signal)}）\n${tail}` }
  if (!existsSync(join(directory, 'package.json'))) return { status: 'failed', tail: `CLI 退出成功但没有生成 ${join(directory, 'package.json')}\n${tail}` }
  return { status: 'ok', tail }
}
