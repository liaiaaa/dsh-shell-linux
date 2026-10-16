import { describe, expect, it } from 'vitest'
import { connect, createServer, type Server, type Socket } from 'node:net'
import {
  cacheUpstream, createPathProver, isPlainRequest, parseConnectTarget, planAttempts,
  CONNECT_BUDGET_MS, DIRECT_ATTEMPTS, serveTunnelConnection, startTunnel, waitForProxyHello,
  type Proof, type TunnelAttempt, type TunnelResult,
} from '../src/main/tunnel.ts'
import { type SystemProxy } from '../src/main/system-proxy.ts'

const CRLF = String.fromCharCode(13, 10)

/**
 * A local listener that answers the FIRST bytes it receives.
 *
 * This is what an origin looks like from inside a tunnel: it is not a proxy, so it has no header
 * block to wait for - it just receives whatever the client sends down the tunnel.
 */
const serveOrigin = (reply: string): Promise<{ port: number, server: Server, received: () => string }> =>
  new Promise((resolve) => {
    let got = ''
    const server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => { got += chunk.toString('latin1'); socket.write(reply) })
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server, received: () => got }))
  })

/** A fake HTTP proxy: it waits for a CONNECT header block, then answers with a fixed status line. */
const serveProxy = (status: string, extra = ''): Promise<{ port: number, server: Server, received: () => string }> =>
  new Promise((resolve) => {
    let got = ''
    const server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        got += chunk.toString('latin1')
        if (got.indexOf(CRLF + CRLF) < 0) return
        socket.write('HTTP/1.1 ' + status + CRLF + CRLF + extra)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server, received: () => got }))
  })

/** A port nothing listens on, learned by binding and releasing it. */
const closedPort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port
    server.close(() => resolve(port))
  })
})

/** Ask a tunnel to carry one connection, and report the status line plus whatever came after it. */
const throughTunnel = (port: number, target: string, payload = ''): Promise<{ reply: string, body: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let reply = ''
    let body = ''
    socket.setTimeout(8_000, () => { socket.destroy(); reject(new Error('tunnel client timed out')) })
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      if (reply === '') {
        reply = chunk.toString('latin1')
        const end = reply.indexOf(CRLF + CRLF)
        if (end < 0) return
        body = reply.slice(end + 4)
        reply = reply.slice(0, end)
        if (body !== '') { resolve({ reply, body }); socket.destroy() }
        return
      }
      body += chunk.toString('latin1')
      resolve({ reply, body })
      socket.destroy()
    })
    socket.on('close', () => resolve({ reply, body }))
    socket.write('CONNECT ' + target + ' HTTP/1.1' + CRLF + 'Host: ' + target + CRLF + CRLF + payload)
  })

describe('parseConnectTarget', () => {
  it('reads a CONNECT authority and nothing else', () => {
    expect(parseConnectTarget('CONNECT platform.deepseek.com:443 HTTP/1.1')).toEqual({ host: 'platform.deepseek.com', port: 443 })
    expect(parseConnectTarget('GET http://127.0.0.1/ HTTP/1.1')).toBeNull()
    expect(parseConnectTarget('CONNECT noport HTTP/1.1')).toBeNull()
    expect(parseConnectTarget('CONNECT :443 HTTP/1.1')).toBeNull()
    expect(parseConnectTarget('CONNECT host:0 HTTP/1.1')).toBeNull()
    expect(parseConnectTarget('CONNECT host:70000 HTTP/1.1')).toBeNull()
  })
  it('refuses a plain request rather than guessing at it', () => {
    expect(isPlainRequest('GET http://example.com/ HTTP/1.1')).toBe(true)
    expect(isPlainRequest('CONNECT example.com:443 HTTP/1.1')).toBe(false)
    expect(isPlainRequest('')).toBe(false)
  })
})

describe('planAttempts', () => {
  const target = { host: 'platform.deepseek.com', port: 443 }
  const proxy: SystemProxy = { host: '127.0.0.1', port: 10808 }
  it('tries the proxy first and falls back to direct', () => {
    const plans = planAttempts(proxy, target)
    expect(plans[0]).toMatchObject({ path: 'proxy', host: '127.0.0.1', port: 10808 })
    expect(plans.slice(1).every((plan) => plan.path === 'direct')).toBe(true)
    expect(plans.at(-1)).toMatchObject({ host: target.host, port: 443 })
  })
  it('gives direct more than one try, because the measured failure is per-connection randomness', () => {
    expect(planAttempts(null, target)).toHaveLength(DIRECT_ATTEMPTS)
  })
  it('fits every planned attempt inside the client budget', () => {
    // A plan the budget cannot pay for is dead code that quietly lengthens the wait the tunnel is
    // supposed to bound, so the sum is asserted rather than eyeballed.
    const total = planAttempts(proxy, target).reduce((sum, plan) => sum + plan.attemptMs, 0)
    expect(total).toBeLessThanOrEqual(CONNECT_BUDGET_MS)
  })
})

describe('cacheUpstream', () => {
  it('asks the machine once for a burst of connections', async () => {
    let calls = 0
    const probe = cacheUpstream(async () => { calls += 1; return { host: '127.0.0.1', port: 10808 } }, 10_000)
    const results = await Promise.all([probe(), probe(), probe()])
    expect(calls).toBe(1)
    expect(results[0]).toEqual(results[2])
  })
  it('asks again once the answer is stale, which is how a late proxy gets used', async () => {
    let calls = 0
    let now = 0
    const probe = cacheUpstream(async () => { calls += 1; return calls >= 2 ? { host: '127.0.0.1', port: 10809 } : null }, 1_000, () => now)
    expect(await probe()).toBeNull()
    now = 500
    expect(await probe()).toBeNull()
    expect(calls).toBe(1)
    now = 1_500
    expect(await probe()).toEqual({ host: '127.0.0.1', port: 10809 })
    expect(calls).toBe(2)
  })
  it('turns a throwing probe into "no proxy" instead of failing the connection', async () => {
    const probe = cacheUpstream(async () => { throw new Error('gsettings died') })
    await expect(probe()).resolves.toBeNull()
  })
})

describe('createPathProver', () => {
  const plan = { path: 'direct' as const, host: '127.0.0.1', port: 443, attemptMs: 500 }
  const target = { host: 'platform.deepseek.com', port: 443 }
  it('skips the proof for a port that is not TLS, rather than calling a good path broken', async () => {
    let dials = 0
    const prover = createPathProver(async () => { dials += 1; throw new Error('must not dial') })
    await expect(prover(plan, { host: 'x', port: 8443 }, 500)).resolves.toBeUndefined()
    expect(dials).toBe(0)
  })
  it('shares one proof with the burst instead of paying a handshake per request', async () => {
    let dials = 0
    const prover = createPathProver(async () => { dials += 1; return { destroy(): void { /* fake */ }, removeAllListeners(): void {} } as never }, 10_000)
    await expect(prover(plan, target, 500)).resolves.toBeUndefined()
    await prover(plan, target, 500)
    expect(dials).toBe(1)
  })
})

describe('waitForProxyHello', () => {
  const socketTo = (port: number): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
  it('accepts 200 and hands over the bytes that came with it', async () => {
    const up = await serveProxy('200 Connection established', 'LEFTOVER')
    const socket = await socketTo(up.port)
    const hello = await waitForProxyHello(socket, { host: 'a.example', port: 443 }, 3_000)
    // `extra` is a Buffer, and that is the point: the bytes after a proxy's status line are a TLS
    // record. Decoded to a string and written back, 0xFF becomes two UTF-8 bytes and the request is
    // corrupted - which is exactly how this tunnel once broke every account call while its own
    // ASCII-only tests stayed green.
    expect(hello.ok).toBe(true)
    expect(Buffer.isBuffer(hello.extra)).toBe(true)
    expect(hello.extra.toString('latin1')).toBe('LEFTOVER')
    expect(up.received()).toContain('CONNECT a.example:443 HTTP/1.1')
    socket.destroy(); up.server.close()
  })
  it('rejects a refusal, so a listener that is not a proxy is never tunnelled through', async () => {
    const up = await serveProxy('400 Bad Request')
    const socket = await socketTo(up.port)
    expect((await waitForProxyHello(socket, { host: 'a.example', port: 443 }, 3_000)).ok).toBe(false)
    socket.destroy(); up.server.close()
  })
  it('rejects a listener that answers nothing, within its budget', async () => {
    // A silent listener is the realistic worst case: something is in there, it accepts, and it says
    // no more. Without the bound this hop would eat the whole client budget.
    const server = createServer(() => { /* accepts and stays quiet */ })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    const socket = await socketTo(port)
    const started = Date.now()
    expect((await waitForProxyHello(socket, { host: 'a.example', port: 443 }, 300)).ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
    socket.destroy(); server.close()
  })
})

describe('a failed proof must not short-circuit the retry', () => {
  const target = { host: 'platform.deepseek.com', port: 443 }

  /**
   * The bug this exists for: the path proof cached its NO as well as its YES, so a connection's
   * second direct attempt returned the FIRST attempt's failure without touching the network. In the
   * user's real boot log one request read `direct=fail(connect timeout) direct=fail(connect
   * timeout (cached))` and died 502, while a sibling connection in the same instant got
   * `up 838ms direct=ok`. Retrying is the entire defence against a path that resets some connections
   * and not others, so caching the failure deleted the fix - and every test stayed green because
   * they asserted the caching behaviour rather than the recovery.
   */
  it('re-probes on the second attempt, so a transient reset still serves the request', async () => {
    let probes = 0
    const flaky: Proof = async () => {
      probes += 1
      if (probes < 2) throw new Error('ECONNRESET (transient)')
    }
    const prove = createPathProver(flaky, 10_000)
    const plans = planAttempts(null, target)
    expect(plans).toHaveLength(DIRECT_ATTEMPTS)
    await expect(prove(plans[0], target, 500)).rejects.toThrow('transient')
    await expect(prove(plans[1], target, 500)).resolves.toBeUndefined()
    expect(probes).toBe(DIRECT_ATTEMPTS)
  })

  it('still shares one SUCCESS with the burst, which is what the cache is for', async () => {
    let probes = 0
    const prove = createPathProver(async () => { probes += 1 }, 10_000)
    const plan = planAttempts(null, target)[0]
    await prove(plan, target, 500)
    await prove(plan, target, 500)
    await prove(plan, target, 500)
    expect(probes).toBe(1)
  })
})

describe('the tunnel, end to end over loopback', () => {
  const none = async (): Promise<SystemProxy | null> => null

  it('tunnels straight to the target when no proxy is offered', async () => {
    const origin = await serveOrigin('PONG')
    const results: TunnelResult[] = []
    const tunnel = await startTunnel(none, undefined, (result) => { results.push(result) }, 8_000)
    const answer = await throughTunnel(tunnel.port, '127.0.0.1:' + String(origin.port), 'PING')
    expect(answer.reply).toContain('200 Connection established')
    expect(answer.body).toContain('PONG')
    expect(origin.received()).toContain('PING')
    expect(results.at(-1)).toMatchObject({ ok: true })
    await tunnel.close()
    origin.server.close()
  })

  it('falls back to direct when the offered proxy refuses CONNECT', async () => {
    // The point of the fallback: a proxy the machine still believes in must not be able to black out
    // the session. Refusing the client with 502 while a working direct path exists would be worse.
    const refusing = await serveProxy('501 Not Implemented')
    const origin = await serveOrigin('PONG-DIRECT')
    const results: TunnelResult[] = []
    const tunnel = await startTunnel(async () => ({ host: '127.0.0.1', port: refusing.port }),
      undefined, (result) => { results.push(result) }, 8_000)
    const answer = await throughTunnel(tunnel.port, '127.0.0.1:' + String(origin.port), 'PING')
    expect(answer.reply).toContain('200 Connection established')
    expect(answer.body).toContain('PONG-DIRECT')
    const logged = results.at(-1)?.attempts ?? []
    expect(logged.some((attempt) => attempt.path === 'proxy' && !attempt.ok)).toBe(true)
    expect(logged.some((attempt) => attempt.path === 'direct' && attempt.ok)).toBe(true)
    // The hop really was asked for a tunnel, not just connected to.
    expect(refusing.received()).toContain('CONNECT 127.0.0.1:' + String(origin.port))
    await tunnel.close()
    refusing.server.close()
    origin.server.close()
  })

  it('chains through a proxy that accepts, and forwards its early bytes to the client', async () => {
    // `extra` is the regression this test exists for: slicing the leftover by one CRLF instead of
    // the four-byte blank line would hand the client a stray CRLF and desync its TLS record.
    const hop = await serveProxy('200 Connection established', 'HOP-EARLY')
    const results: TunnelResult[] = []
    const tunnel = await startTunnel(async () => ({ host: '127.0.0.1', port: hop.port }),
      undefined, (result) => { results.push(result) }, 8_000)
    const answer = await throughTunnel(tunnel.port, 'platform.deepseek.com:443')
    expect(answer.reply).toContain('200 Connection established')
    expect(answer.body).toContain('HOP-EARLY')
    expect(results.at(-1)?.ok).toBe(true)
    expect(results.at(-1)?.attempts[0]).toMatchObject({ path: 'proxy', ok: true })
    await tunnel.close()
    hop.server.close()
  })

  it('answers 502 quickly when nothing works, instead of holding the client open', async () => {
    const closed = await closedPort()
    const refusing = await serveProxy('501 Not Implemented')
    const results: TunnelResult[] = []
    const tunnel = await startTunnel(async () => ({ host: '127.0.0.1', port: refusing.port }),
      undefined, (result) => { results.push(result) }, 8_000)
    const started = Date.now()
    const answer = await throughTunnel(tunnel.port, '127.0.0.1:' + String(closed))
    expect(answer.reply).toContain('502')
    // The bound is the whole point: a wedged path has to become an ordinary fast network error,
    // because the account plugin's own timeout cannot cut a connect it does not own.
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(results.at(-1)?.ok).toBe(false)
    await tunnel.close()
    refusing.server.close()
  })

  it('refuses a plain absolute-form request', async () => {
    const tunnel = await startTunnel(none, undefined, () => {}, 8_000)
    const answer = await new Promise<{ reply: string }>((resolve, reject) => {
      const client = connect({ host: '127.0.0.1', port: tunnel.port })
      let text = ''
      client.on('data', (chunk: Buffer) => { text += chunk.toString('latin1'); if (text.indexOf(CRLF + CRLF) >= 0) resolve({ reply: text }) })
      client.on('error', reject)
      client.setTimeout(4_000, () => reject(new Error('no reply')))
      client.once('connect', () => client.write('GET http://127.0.0.1/ HTTP/1.1' + CRLF + CRLF))
    })
    expect(answer.reply).toContain('405')
    await tunnel.close()
  })
})

describe('the route is re-decided per connection', () => {
  /** A fake CONNECT proxy that answers 200 and then identifies itself down the tunnel. */
  const serveFakeProxy = (): Promise<{ port: number, server: Server, hits: () => number }> =>
    new Promise((resolve) => {
      let hits = 0
      const server = createServer((socket) => {
        let got = ''
        socket.on('data', (chunk: Buffer) => {
          got += chunk.toString('latin1')
          if (got.indexOf(CRLF + CRLF) < 0) return
          hits += 1
          socket.write('HTTP/1.1 200 Connection established' + CRLF + CRLF + 'PONG-VIA-PROXY')
        })
      })
      server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server, hits: () => hits }))
    })

  it('uses the proxy while it is up, then direct on the very next request after it dies', async () => {
    // This is the user's boot case and the reason the tunnel exists. Round 37 decided once at
    // launch and froze the child's environment, so a proxy appearing (or vanishing) minutes later
    // changed nothing for the rest of the session. Here the second connection must notice.
    const proxy = await serveFakeProxy()
    const origin = await serveOrigin('PONG-DIRECT')
    const results: TunnelResult[] = []
    let offered = true
    const tunnel = await startTunnel(async () => (offered ? { host: '127.0.0.1', port: proxy.port } : null),
      undefined, (result) => { results.push(result) }, 8_000)
    const target = '127.0.0.1:' + String(origin.port)

    const first = await throughTunnel(tunnel.port, target)
    expect(first.body).toContain('PONG-VIA-PROXY')
    expect(results.at(-1)?.attempts[0]).toMatchObject({ path: 'proxy', ok: true })

    offered = false
    // The payload rides in the SAME packet as the CONNECT headers, which is the case that was
    // silently dropped by an earlier version: an origin that never saw it would never answer.
    const second = await throughTunnel(tunnel.port, target, 'PING')
    expect(second.body).toContain('PONG-DIRECT')
    expect(origin.received()).toContain('PING')
    expect(results.at(-1)?.attempts.some((attempt) => attempt.path === 'direct' && attempt.ok)).toBe(true)
    // And the proxy really was asked only once: no leftover tunnel from the first connection.
    expect(proxy.hits()).toBe(1)

    await tunnel.close()
    proxy.server.close()
    origin.server.close()
  })
})

describe('binary fidelity, which is the whole job of a TLS tunnel', () => {
  /**
   * Bytes must arrive byte-identical, in both directions.
   *
   * This is a regression this tunnel shipped with once: it decoded the stream as latin1 text and
   * wrote it back, and a write of a string encodes as UTF-8 - so a single 0xFF became 0xC3 0x9F and
   * every TLS record after the CONNECT was corrupted. The account calls failed in ~350ms while all
   * the ASCII-only tests stayed green, which is why the payload here deliberately contains 0xFF.
   */
  it('carries 0xFF and the bytes around it through the tunnel unchanged', async () => {
    const payload = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x05, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x9f])
    const seen: Buffer[] = []
    const origin = new (await import('node:net')).Server((socket) => {
      socket.on('data', (chunk: Buffer) => { seen.push(chunk); socket.write(payload) })
    })
    const port = await new Promise<number>((resolve) => origin.listen(0, '127.0.0.1', () => resolve((origin.address() as { port: number }).port)))
    const tunnel = await startTunnel(async () => null, undefined, () => {}, 8_000)
    const client = connect({ host: '127.0.0.1', port: tunnel.port })
    const head = 'CONNECT 127.0.0.1:' + String(port) + ' HTTP/1.1' + CRLF + CRLF
    const reply = await new Promise<string>((resolve, reject) => {
      let text = ''
      const got: Buffer[] = []
      client.on('error', reject)
      client.setTimeout(5_000, () => reject(new Error('no reply')))
      client.on('data', (chunk: Buffer) => {
        if (text === '') {
          const combined = Buffer.concat([Buffer.alloc(0), chunk]).toString('latin1')
          const end = combined.indexOf(CRLF + CRLF)
          if (end < 0) { text = combined; return }
          text = combined.slice(0, end)
          if (combined.length > end + 4) { resolve(combined); client.destroy(); return }
          return
        }
        got.push(chunk)
        resolve(text + CRLF + CRLF + Buffer.concat(got).toString('latin1'))
        client.destroy()
      })
      // The payload rides in the same packet as the CONNECT, the way a ClientHello follows it.
      client.once('connect', () => client.write(Buffer.concat([Buffer.from(head, 'latin1'), payload])))
    })
    expect(reply).toContain('200 Connection established')
    expect(Buffer.from(reply.slice(reply.indexOf(CRLF + CRLF) + 4), 'latin1')).toEqual(payload)
    // And what the origin received is the client's bytes, unmodified.
    expect(Buffer.concat(seen)).toEqual(payload)
    await tunnel.close()
    origin.close()
  })
})

describe('serveTunnelConnection with injected paths', () => {
  /**
   * A client socket that only needs to record writes and let the test drive its events.
   *
   * Deliberately minimal: the unit under test only ever calls setEncoding/write/end/destroy/on, so
   * anything more would be a second fake socket implementation to keep honest.
   */
  const fakeClient = (): { socket: Socket, written: string[] } => {
    const written: string[] = []
    const handlers = new Map<string, Array<(arg?: unknown) => void>>()
    const socket = {
      setEncoding(): void {},
      // The tunnel writes headers as (text, 'latin1') and body bytes as Buffers; a fake that only
      // took strings would have hidden the encoding bug that actually happened.
      write(chunk: string | Buffer): void { written.push(typeof chunk === 'string' ? chunk : chunk.toString('latin1')) },
      end(): void {},
      destroy(): void {},
      setTimeout(): void {},
      pause(): void {},
      resume(): void {},
      on(name: string, fn: (arg?: unknown) => void): void {
        const list = handlers.get(name)
        if (list === undefined) handlers.set(name, [fn])
        else list.push(fn)
      },
      once(name: string, fn: (arg?: unknown) => void): void { socket.on(name, fn) },
      removeListener(): void {},
      emit(name: string, arg?: unknown): void {
        for (const fn of handlers.get(name) ?? []) fn(arg)
      },
    } as unknown as Socket
    return { socket, written }
  }

  const CONNECT_443 = 'CONNECT platform.deepseek.com:443 HTTP/1.1' + CRLF + CRLF

  it('proves the direct path more than once before it gives up, then answers 502', async () => {
    const client = fakeClient()
    const reasons: string[] = []
    const results: TunnelResult[] = []
    const prove = async (): Promise<void> => { reasons.push('attempt'); throw new Error('reset after handshake') }
    const dial = async (): Promise<Socket> => { throw new Error('must not dial a path that failed proof') }
    serveTunnelConnection(client.socket, async () => null, prove, dial,
      (result) => { results.push(result) }, 4_000)
    // A real socket hands the handler a Buffer unless setEncoding was called, and it must not be
    // called: see the encoding comment in tunnel.ts.
    client.socket.emit('data', Buffer.from(CONNECT_443, 'latin1'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    // Retried, because the measured failure is per-connection randomness rather than a dead path:
    // in the user's own window three raw requests answered 200 while four died in the same batch.
    expect(reasons).toHaveLength(DIRECT_ATTEMPTS)
    expect(results.at(-1)?.ok).toBe(false)
    expect(client.written.join('')).toContain('502')
    // And a path that could not be proved is never handed to the client.
    expect(client.written.join('')).not.toContain('200 Connection established')
  })

  it('answers 502 to a client that never finishes its request line', async () => {
    const client = fakeClient()
    serveTunnelConnection(client.socket, async () => null, async () => {}, async () => {
      throw new Error('unused')
    }, () => {}, 120)
    client.socket.emit('data', Buffer.from('CONNECT platform.deepseek.com:443 HTTP/1.1' + CRLF, 'latin1'))
    await new Promise((resolve) => { setTimeout(resolve, 250) })
    expect(client.written.join('')).toContain('502')
  })
})
