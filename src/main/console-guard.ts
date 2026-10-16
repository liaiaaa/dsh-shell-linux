/**
 * Keep a detached stdout/stderr from killing the shell.
 *
 * The failure this exists for (reproduced end to end): the shell pipes the host child's
 * stdout to its own `process.stdout`, and that stream is a pipe owned by whoever launched the app
 * (here: the GNOME session, which is why the journal shows these lines as `gnome-shell[…]: DING:`).
 * When the reader goes away — screen off / lock / session restart / a pager that quit — the next
 * write raises `EPIPE`, and an `error` event with no listener is re-thrown as an uncaught exception.
 * Electron then shows its "A JavaScript error occurred in the main process" dialog and the whole
 * shell dies, taking the host child with it. The user's report was exactly that, "occasionally", on
 * screen-off: gnome-shell had changed PID seven times that day.
 *
 * Two measured facts shape this file, and both are counter-intuitive:
 *  1. A `try`/`catch` around the write does NOT help, and neither does the write callback, nor
 *     `console.log`. The error is emitted asynchronously on the stream, outside any call stack, so
 *     the only thing that prevents the crash is having an `error` listener attached at all.
 *  2. After EPIPE the stream still reports `writable === true` and `destroyed === false`, so
 *     liveness cannot be read off the stream. This module therefore records the loss itself and
 *     stops writing, which also ends the error-per-write storm (measured: 52 errors in 1.2s).
 *
 * Installing one guard per stream is what protects every other writer in the process too, including
 * `console.log`/`console.error` calls this module never sees.
 */

/** The slice of a writable stream this module needs; `process.stdout` and a socket both satisfy it. */
export type WritableLike = {
  write(chunk: string | Uint8Array): boolean
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/** A guarded stream: writes are safe, and the loss of the reader is remembered. */
export type StreamGuard = {
  /** True until the reader disappears; after that, writes are dropped instead of raising EPIPE. */
  readonly alive: boolean
  /**
   * Write unless the reader is already gone.
   *
   * @returns true when the bytes were handed to the stream, false when they were dropped.
   */
  write(chunk: string | Uint8Array): boolean
}

/**
 * Guard one output stream against a vanished reader.
 *
 * @param stream - the stream to protect (usually `process.stdout` or `process.stderr`).
 * @param onLost - called once, with the error, when the reader is first found to be gone. Used for a
 *                 best-effort note in the stderr tail; it must never write to the same stream.
 * @returns a guard whose `write` is safe for the rest of the process's life.
 */
export function guardStream(stream: WritableLike, onLost?: (error: NodeJS.ErrnoException) => void): StreamGuard {
  let alive = true
  stream.on('error', (error: NodeJS.ErrnoException) => {
    // First loss only: the error fires again on every subsequent write, and a diagnostic that
    // repeats 50 times a second is noise, not information.
    if (!alive) return
    alive = false
    onLost?.(error)
  })
  return {
    get alive(): boolean { return alive },
    write(chunk: string | Uint8Array): boolean {
      if (!alive) return false
      stream.write(chunk)
      return true
    },
  }
}

/** Guards for the process's own two output streams, created once and reused. */
export type ProcessStreamGuards = { readonly stdout: StreamGuard, readonly stderr: StreamGuard }

let installed: ProcessStreamGuards | undefined

/**
 * Install the guards on `process.stdout` and `process.stderr`, once per process.
 *
 * Called at the top of the shell's entry module, before anything can write: `console.log` in any
 * later module is then safe even though it never touches this API. Idempotent, so a second call
 * (for example from a test that imports the entry) cannot stack duplicate listeners.
 *
 * @returns the guards, for callers that want to forward bytes explicitly.
 */
export function installProcessStreamGuards(): ProcessStreamGuards {
  if (installed !== undefined) return installed
  // No `onLost` note: both streams are the thing that is gone, so there is nowhere to report it to.
  installed = {
    stdout: guardStream(process.stdout),
    stderr: guardStream(process.stderr),
  }
  return installed
}
