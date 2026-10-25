/**
 * Child-process lifecycle for the user's web profile.
 * Adapted from deepseek-ai/deepseek-harness apps/desktop/src/host-process.ts (MIT).
 *
 * Divergence from the official recipe (recorded as decision D4 in
 * a design decision recorded during development): the official Desktop runs the child under the
 * Electron binary with `ELECTRON_RUN_AS_NODE=1`. That breaks the user's
 * `@deepseek-ai/dsh-skill-office` plugin, which refuses to start whenever
 * `process.versions.electron` is defined. This shell deliberately carries no DSH
 * runtime of its own, so the packaged-app assumption behind that recipe does not
 * apply: the child runs under a standalone system Node and the environment is
 * left untouched.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isHostEvent, type HostEvent } from '../shared/ipc.ts'
import { installProcessStreamGuards, type StreamGuard } from './console-guard.ts'

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024
/** Longest partial stdout line kept while waiting for the newline that ends it. */
const MAX_STDOUT_LINE_CHARS = 8 * 1024
const SHUTDOWN_ACK_MS = 10_000
const SIGTERM_GRACE_MS = 5_000
const SIGKILL_GRACE_MS = 2_000

/** Standalone Node used to run the host child when `DSH_DESKTOP_NODE` is unset. */
export const DEFAULT_HOST_NODE = '/usr/bin/node'

export class HostFatalError extends Error {
  constructor(message: string, readonly diagnostic: string | undefined) { super(message) }
}

/**
 * Resolve the interpreter that runs the host child.
 * @param environment - Environment consulted for the `DSH_DESKTOP_NODE` override.
 * @returns An absolute path to an existing, executable file.
 * @throws When the configured interpreter is not an absolute path, is missing, is not a regular
 * file, or is not executable. The message is user-facing: it reaches the error window verbatim.
 */
export function resolveHostNode(environment: NodeJS.ProcessEnv = process.env): string {
  const candidate = environment.DSH_DESKTOP_NODE ?? DEFAULT_HOST_NODE
  if (!isAbsolute(candidate)) {
    throw new Error(`DSH_DESKTOP_NODE must be an absolute path to a Node executable, got "${candidate}"`)
  }
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(candidate)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error'
    throw new Error(`Node executable "${candidate}" is unavailable (${code}). Install Node, or point DSH_DESKTOP_NODE at one.`)
  }
  if (!stats.isFile()) throw new Error(`Node executable "${candidate}" is not a regular file.`)
  try {
    accessSync(candidate, constants.X_OK)
  } catch {
    throw new Error(`Node executable "${candidate}" is not executable.`)
  }
  return candidate
}

function sleep(milliseconds: number): Promise<false> {
  return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), milliseconds); timer.unref() })
}

/**
 * The user-facing message for a host child's exit, or undefined when the exit is the
 * expected part of a planned shutdown. Signal deaths must say so: "host stopped" for a
 * SIGKILLed child would send debugging down the wrong path.
 */
export function describeHostExit(exit: { code: number | null; signal: NodeJS.Signals | null; stopping: boolean; stderrTail: string }): string | undefined {
  if (exit.stopping) return undefined
  const suffix = exit.stderrTail === '' ? '' : `: ${exit.stderrTail}`
  if (exit.code !== null && exit.code !== 0) return `dsh desktop host exited with ${String(exit.code)}${suffix}`
  if (exit.signal !== null) return `dsh desktop host was killed by ${exit.signal}${suffix}`
  return `dsh desktop host stopped${suffix}`
}

/**
 * Mask tokens in a host log line before it reaches the shell's own stdout.
 *
 * The host prints its authenticated URL — `dsh web: http://127.0.0.1:<port>/?token=…` — on boot and
 * the shell forwards everything the child prints to its own stdout, which lands in the systemd user
 * journal. Without this the token sits in `journalctl --user` for as long as that host lives.
 * A forwarded log line is still a log line, so credentials are masked here too.
 */
export function redactTokens(text: string): string {
  return text.replace(/([?&]token=)[^\s&"']+/g, '$1<redacted>')
}

export class HostProcess {
  private child: ChildProcess | undefined
  private stderr = ''
  /** Stdout line not yet terminated by a newline; see forwardStdout(). */
  private stdoutPending = ''
  private stopping = false
  private readonly listeners = new Set<(event: HostEvent) => void>()
  private readonly exitWaiters = new Set<() => void>()
  /**
   * Guards the shell's own stdout while the child's log lines are forwarded to it.
   *
   * This forwarding is what crashed the shell once: the host logs constantly, so it is the
   * write that hits a detached stdout first. `guardStream` keeps an `error` listener attached (the
   * only thing that prevents the uncaught exception) and stops writing once the reader is gone.
   */
  private readonly outbound: StreamGuard

  constructor(
    private readonly node: string,
    private readonly hostEntry: string,
    private readonly profileDir: string,
    private readonly environment: NodeJS.ProcessEnv,
    stdout: StreamGuard = installProcessStreamGuards().stdout,
  ) { this.outbound = stdout }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    if (this.child !== undefined) return
    const child = spawn(this.node, ['--expose-internals', this.hostEntry, this.profileDir], {
      cwd: this.profileDir,
      // D4: the interpreter is a standalone Node, so the child environment is passed
      // through as-is — no ELECTRON_RUN_AS_NODE, which would reintroduce
      // `process.versions.electron` and break the office-skills plugin.
      env: { ...this.environment },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    // Forwarded through the guard, not written straight to `process.stdout`: once the reader is gone
    // this drops the bytes instead of raising EPIPE, which would otherwise reach Electron as an
    // uncaught exception and replace the window with an error dialog. Whole lines are forwarded so a
    // `?token=…` split across two chunks is still masked (see redactTokens).
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.forwardStdout(chunk) })
    child.on('message', (message: unknown) => {
      if (!isHostEvent(message)) {
        this.fail(new Error('dsh-shell-linux host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      for (const listener of this.listeners) listener(message)
    })
    child.once('error', (error) => { this.fail(error) })
    child.once('close', (code, signal) => {
      this.flushStdout()
      const message = describeHostExit({ code, signal, stopping: this.stopping, stderrTail: this.stderr.trim() })
      this.fail(message === undefined ? undefined : new Error(message))
    })
  }

  /** The child's stderr tail for diagnostics; never logged wholesale to the conversation. */
  stderrTail(): string { return this.stderr.trim() }

  /** Ladder: shutdown ack 10s → SIGTERM 5s → SIGKILL 2s. Resolves once the child is gone. */
  async shutdown(): Promise<void> {
    const child0 = this.child
    if (child0 === undefined || this.stopping) return
    this.stopping = true
    const exited = new Promise<void>((resolve) => { this.exitWaiters.add(resolve) })
    // `send` throws if the channel is already gone (crashed child); the ladder below still runs.
    try { child0.send({ type: 'shutdown' }) } catch { /* fall through to signals */ }
    if (await Promise.race([exited.then(() => true), sleep(SHUTDOWN_ACK_MS)])) return
    child0.kill('SIGTERM')
    if (await Promise.race([exited.then(() => true), sleep(SIGTERM_GRACE_MS)])) return
    child0.kill('SIGKILL')
    await Promise.race([exited, sleep(SIGKILL_GRACE_MS)])
  }

  /** Mask and forward a stdout chunk, holding an unterminated last line until it ends. */
  private forwardStdout(chunk: string): void {
    this.stdoutPending += chunk
    const lines = this.stdoutPending.split('\n')
    this.stdoutPending = lines.pop() ?? ''
    if (lines.length > 0) this.outbound.write(lines.map(redactTokens).join('\n') + '\n')
    // A line that never ends must not grow the buffer without bound: forward it masked as partial.
    if (this.stdoutPending.length > MAX_STDOUT_LINE_CHARS) {
      this.outbound.write(redactTokens(this.stdoutPending))
      this.stdoutPending = ''
    }
  }

  /** Forward whatever the child printed without a trailing newline before its stream closes. */
  private flushStdout(): void {
    if (this.stdoutPending === '') return
    this.outbound.write(redactTokens(this.stdoutPending))
    this.stdoutPending = ''
  }

  private fail(error: Error | undefined): void {
    // Snapshot before notifying: a waiter must not observe a half-drained set.
    for (const waiter of [...this.exitWaiters]) waiter()
    this.exitWaiters.clear()
    if (error === undefined) return
    for (const listener of this.listeners) listener({ type: 'fatal', message: error.message, diagnostic: error instanceof HostFatalError ? error.diagnostic : this.stderrTail() })
  }
}
