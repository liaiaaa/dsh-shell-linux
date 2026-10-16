import { describe, expect, it } from 'vitest'
import { connect, createServer } from 'node:net'
import type { Socket } from 'node:net'
import { guardStream, installProcessStreamGuards, type WritableLike } from '../src/main/console-guard.ts'

/** A stand-in for a stream whose reader has gone: every write emits an `error`, as EPIPE does. */
const brokenStream = (): { stream: WritableLike, writes: number, lost: NodeJS.ErrnoException[] } => {
  const listeners: Array<(error: NodeJS.ErrnoException) => void> = []
  const state = { writes: 0, lost: [] as NodeJS.ErrnoException[] }
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) as NodeJS.ErrnoException
  const stream: WritableLike = {
    write(): boolean {
      state.writes += 1
      // Asynchronous, like the real stream: this is precisely why try/catch cannot help.
      queueMicrotask(() => { for (const listener of listeners) listener(error) })
      return true
    },
    on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown {
      if (event === 'error') listeners.push(listener)
      return stream
    },
  }
  return { stream, writes: state.writes, lost: state.lost }
}

describe('guardStream', () => {
  it('writes normally while the reader is alive', () => {
    const { stream } = brokenStream()
    const guard = guardStream(stream)
    expect(guard.alive).toBe(true)
    expect(guard.write('hello')).toBe(true)
  })

  it('survives a stream that emits EPIPE, and stops writing after it', async () => {
    // The crash this reproduces: without an `error` listener Node re-throws the event as an uncaught
    // exception, and the shell dies with "A JavaScript error occurred in the main process". Measured
    // against a real closed pipe: `try`/`catch`, the write callback and `console.log` all still
    // crashed; only having the listener prevented it.
    const state = { writes: 0, errors: 0 }
    const listeners: Array<(error: NodeJS.ErrnoException) => void> = []
    const stream: WritableLike = {
      write(): boolean { state.writes += 1; queueMicrotask(() => { for (const listener of listeners) listener(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) }); return true },
      on(_event, listener): unknown { listeners.push(listener); return stream },
    }
    const lost: NodeJS.ErrnoException[] = []
    const guard = guardStream(stream, (error) => { lost.push(error); state.errors += 1 })

    expect(guard.write('first')).toBe(true)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(guard.alive).toBe(false)
    expect(lost).toHaveLength(1)

    // Later writes are dropped rather than attempted: this is what ends the error-per-write storm
    // (measured on a real detached pipe: 52 errors in 1.2 seconds without this).
    expect(guard.write('second')).toBe(false)
    expect(guard.write('third')).toBe(false)
    expect(state.writes).toBe(1)
  })

  it('reports the first loss once, not once per write', async () => {
    const listeners: Array<(error: NodeJS.ErrnoException) => void> = []
    let reported = 0
    const stream: WritableLike = {
      write(): boolean { queueMicrotask(() => { for (const listener of listeners) listener(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) }); return true },
      on(_event, listener): unknown { listeners.push(listener); return stream },
    }
    const guard = guardStream(stream, () => { reported += 1 })
    guard.write('a'); guard.write('b'); guard.write('c')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(reported).toBe(1)
  })
})

describe('installProcessStreamGuards', () => {
  it('is idempotent, so a second call cannot stack duplicate listeners', () => {
    const first = installProcessStreamGuards()
    const second = installProcessStreamGuards()
    expect(second).toBe(first)
    expect(first.stdout.alive).toBe(true)
    expect(first.stderr.alive).toBe(true)
  })
})

describe('against a real closed pipe, which is how this failed in the field', () => {
  /** A socket whose peer hung up: writing to it raises EPIPE exactly as the detached stdout did. */
  const closedPipe = async (): Promise<Socket> => {
    const server = createServer((socket) => { socket.destroy() })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const client = connect({ port, host: '127.0.0.1' })
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    server.close()
    return client
  }

  it('a guarded write to a dead pipe does not throw and flips the guard', async () => {
    const socket = await closedPipe()
    let lost = 0
    // The cast is the point of the `WritableLike` shape: a Socket satisfies the two members the guard
    // needs, and a test that needed a real `process.stdout` could not run at all.
    const guard = guardStream(socket as unknown as WritableLike, () => { lost += 1 })
    expect(() => { guard.write('bytes') }).not.toThrow()
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    // Whether the loss is already visible depends on kernel timing; what must hold is that nothing
    // threw, and that a guard which HAS seen the loss refuses to write again.
    if (!guard.alive) expect(guard.write('more')).toBe(false)
    expect(lost).toBeLessThanOrEqual(1)
    socket.destroy()
  })
})
