/**
 * The shell's own loopback CONNECT tunnel: the host's outbound path is chosen PER CONNECTION.
 *
 * Why a tunnel, and not one decision at launch:
 *  - the route cannot be revised after launch. `dsh-http-proxy` resolves the proxy policy from the
 *    child's environment at process start and keeps it process-wide, and a running child's
 *    environment is not ours to change. A decision made at that instant commits the WHOLE session.
 *  - the boot failure is per-connection, not per-session. The user's own window logged, in one
 *    batch: three raw requests answered 200 at 07:26:50, four raw requests died `read ECONNRESET`
 *    and the proxy only came up eleven seconds later. One probe cannot see that, so an earlier
 *    `rawPathHealthy()` was both a false positive and a session-long commitment.
 *  - blocking the window until a path appears is also wrong: this user runs the proxy only
 *    sometimes, so the proxy may never come, and a blank screen is not better than a slow one.
 *
 * So the host always gets `https_proxy = http://127.0.0.1:<this listener>`. That listener is ALWAYS
 * listening because it is us, which removes by construction the failure mode where a dead proxy
 * named in the environment kills every account call. This file then answers, for each connection and with a
 * fresh look at the machine: proxy now? else direct? and, because the measured failure is a reset
 * AFTER the handshake, does that path actually finish a round trip? If nothing works within
 * CONNECT_BUDGET_MS it replies `502` instead of holding the socket, so the account plugin's own 3s
 * cap can open the gate instead of the UI sitting on "载入历史" for 13-40 seconds.
 *
 * What it never does: it does not terminate TLS for the client, so it never sees a token, cookie or
 * body and cannot log one. The only thing it learns about a request is the CONNECT target host:port.
 */
import { connect, createServer, type Server, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { type SystemProxy } from './system-proxy.ts'

/**
 * One client CONNECT gets this long across ALL attempts before the tunnel answers 502 (ms).
 *
 * It must stay UNDER the account plugin's 3s cap (src/host/overlay-patch.ts), and the reason is a
 * measurement, not a preference: with an earlier broken build, the child gave up at ~3.5s with
 * `aborted: true`. A budget above the cap means the plugin hangs up first and the tunnel's remaining
 * attempts are spent on a request nobody is waiting for - the retries would be decoration. So the
 * plan below is fitted inside this number and the whole thing answers before the client quits.
 */
export const CONNECT_BUDGET_MS = 2_500

/** How long one proxy hop gets (ms): a live xray answered CONNECT+TLS in 72ms, and 170-184ms through
 *  this tunnel measured end to end, so this is headroom rather than a guess. */
export const CONNECT_PROXY_ATTEMPT_MS = 1_200

/** How long one direct path gets for its proof AND the dial the client waits on (ms).
 *
 * Sized so the WHOLE plan fits with room to spare: 1200 + 2 x 600 = 2400 of the 2500 budget. Filling
 * the budget exactly would mean the last attempt is planned but never paid for - the loop reports
 * `budget spent` instead of trying - which is how a launch-time budget check once landed after its probes. */
export const CONNECT_DIRECT_ATTEMPT_MS = 600

/** How many times a failing direct path is retried for one client connection. */
export const DIRECT_ATTEMPTS = 2

/** A resolved upstream is trusted this long before the machine is asked again (ms). */
export const UPSTREAM_CACHE_MS = 1_500

/** A path proof is shared with the burst for this long (ms). Short: the proof is only as good as it
 *  is fresh, and this is the window in which the account plugin's requests actually arrive. */
export const PROOF_CACHE_MS = 1_000

/** Proves one direct path, or rejects with the reason it cannot carry a request. */
export type Prover = (plan: TunnelPlan, target: TunnelTarget, timeoutMs: number) => Promise<void>

/** One proof of one path, before any caching. */
export type Proof = (plan: TunnelPlan, target: TunnelTarget, timeoutMs: number) => Promise<void>

/** The port this tunnel is allowed to prove: anything else is not TLS and a probe would lie. */
export const TLS_PORT = 443

const CRLF = String.fromCharCode(13, 10)
const CRLF_BYTES = Buffer.from(CRLF, 'latin1')
/** The blank line that ends a header block: four bytes, and the offset everything below slices at. */
const HEADER_END = Buffer.from(CRLF + CRLF, 'latin1')
const EMPTY = Buffer.alloc(0)

const OK_200 = 'HTTP/1.1 200 Connection established' + CRLF + CRLF
const BAD_502 = 'HTTP/1.1 502 Bad Gateway' + CRLF + 'Content-Length: 0' + CRLF + CRLF
const NOT_405 = 'HTTP/1.1 405 Method Not Allowed' + CRLF + 'Content-Length: 0' + CRLF + CRLF

/** A CONNECT target, parsed. */
export type TunnelTarget = { readonly host: string, readonly port: number }

/**
 * Parse the opening line of a proxied request.
 *
 * @returns the target to tunnel to, or null when the line is not a CONNECT this tunnel can serve.
 */
export function parseConnectTarget(firstLine: string): TunnelTarget | null {
  const parts = firstLine.trim().split(' ')
  if (parts.length < 3 || parts[0] !== 'CONNECT') return null
  const separator = parts[1].lastIndexOf(':')
  if (separator <= 0) return null
  const host = parts[1].slice(0, separator)
  const port = Number(parts[1].slice(separator + 1))
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

/** True when the opening line is a plain (non-CONNECT) request, which this tunnel refuses. */
export function isPlainRequest(firstLine: string): boolean {
  const method = firstLine.trim().split(' ')[0] ?? ''
  return method !== '' && method !== 'CONNECT'
}

/** A dialer establishes one TCP connection, or rejects within its budget. */
export type Dial = (host: string, port: number, timeoutMs: number) => Promise<Socket>

/**
 * The real dialer: a socket that connected, never one that merely started trying.
 *
 * Handlers are removed by reference rather than with `removeAllListeners`, which is what segfaulted
 * an earlier version once a TLS client had taken over the same socket.
 */
export const dialSocket: Dial = (host, port, timeoutMs) => new Promise((resolve, reject) => {
  let socket: Socket
  try { socket = connect({ host, port }) } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return }
  const detach = (): void => {
    socket.removeListener('connect', onConnect)
    socket.removeListener('timeout', onTimeout)
    socket.removeListener('error', onError)
  }
  const fail = (error: Error): void => {
    detach()
    try { socket.destroy() } catch { /* already gone */ }
    reject(error)
  }
  function onConnect(): void { detach(); socket.setTimeout(0); resolve(socket) }
  function onTimeout(): void { fail(new Error('connect timeout')) }
  function onError(error: Error): void { fail(error) }
  socket.setTimeout(timeoutMs)
  socket.once('connect', onConnect)
  socket.once('timeout', onTimeout)
  socket.once('error', onError)
})

/** Ask the machine for a usable upstream proxy (injected, so the tunnel never forks gsettings itself). */
export type UpstreamProbe = () => Promise<SystemProxy | null>

/**
 * Wrap a probe so a burst of connections asks the machine once.
 *
 * The account plugin fires several requests at the same instant and one probe costs a `gsettings`
 * fork plus a CONNECT and TLS round trip; per connection that would add its own latency to the very
 * stall this module exists to cut. The cache is deliberately short — it is what lets a proxy that
 * comes up ten seconds into a session be used by the NEXT request instead of never.
 */
export function cacheUpstream(probe: UpstreamProbe, ttlMs: number = UPSTREAM_CACHE_MS, now: () => number = Date.now): UpstreamProbe {
  let cached: SystemProxy | null | undefined
  let freshUntil = 0
  let pending: Promise<SystemProxy | null> | undefined
  return async () => {
    if (cached !== undefined && now() < freshUntil) return cached
    if (pending !== undefined) return await pending
    const run = probe().catch(() => null)
    pending = run
    try {
      const answer = await run
      cached = answer
      freshUntil = now() + ttlMs
      return answer
    } finally {
      pending = undefined
    }
  }
}

/** One path attempt, as logged and as returned. */
export type TunnelAttempt = { readonly path: 'proxy' | 'direct', readonly ok: boolean, readonly note: string }

/** One dial plan: which path, which next hop, how long it gets. */
export type TunnelPlan = { readonly path: 'proxy' | 'direct', readonly host: string, readonly port: number, readonly attemptMs: number }

/**
 * The paths to try, in order, for one connection.
 *
 * Proxy first when the machine currently offers one: measured 164-545ms against 13-40s on the raw
 * path, and a literal proxy address does no name resolution at all. It is offered once, because if
 * that listener has gone the direct path is the fallback anyway. Direct gets DIRECT_ATTEMPTS tries,
 * because the failure being defended against is per-connection randomness, not a dead path.
 */
export function planAttempts(upstream: SystemProxy | null, target: TunnelTarget): readonly TunnelPlan[] {
  const plans: TunnelPlan[] = []
  if (upstream !== null) plans.push({ path: 'proxy', host: upstream.host, port: upstream.port, attemptMs: CONNECT_PROXY_ATTEMPT_MS })
  for (let i = 0; i < DIRECT_ATTEMPTS; i += 1) {
    plans.push({ path: 'direct', host: target.host, port: target.port, attemptMs: CONNECT_DIRECT_ATTEMPT_MS })
  }
  return plans
}

/** A next hop's answer to our CONNECT, plus any bytes that arrived in the same packet. */
export type ProxyHello = { readonly ok: boolean, readonly extra: Buffer }

/**
 * Read a proxy's reply to our CONNECT: it must say 200 before a single byte is trusted.
 *
 * `extra` is not a nicety: a net socket cannot put bytes back on the stream, so anything the proxy
 * sent after its status line would otherwise be lost to the tunnel and break the client's TLS record
 * mid-stream. In practice it is empty; the cost of handling it is one slice.
 */
export function waitForProxyHello(socket: Socket, target: TunnelTarget, timeoutMs: number): Promise<ProxyHello> {
  return new Promise((resolve) => {
    // Accumulated as BYTES. Decoding the stream as text is what corrupted this tunnel: the reply is
    // latin1-parseable but everything after it is a TLS record, and a string that gets written back
    // to a socket is re-encoded as UTF-8, turning 0xFF into two bytes. Only the header block is ever
    // decoded, and only to be read.
    let pending = Buffer.alloc(0)
    const finish = (answer: boolean, extra: Buffer = Buffer.alloc(0)): void => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      resolve({ ok: answer, extra })
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk])
      const end = pending.indexOf(HEADER_END)
      if (end < 0) { if (pending.length > 8_192) finish(false); return }
      const header = pending.subarray(0, end).toString('latin1')
      finish(/^HTTP\/1\.[01] 200\b/u.test(header), pending.subarray(end + 4))
    }
    const onError = (): void => finish(false)
    const onClose = (): void => finish(false)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.write(Buffer.from('CONNECT ' + target.host + ':' + String(target.port) + ' HTTP/1.1' + CRLF +
      'Host: ' + target.host + ':' + String(target.port) + CRLF + CRLF, 'latin1'))
  })
}

/** Complete TLS on an already-dialed socket and require one HTTP status line back. */
function proveTlsRoundTrip(host: string, plain: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: TLSSocket
    try { socket = tlsConnect({ socket: plain, servername: host }) }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return }
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('path proof timeout')), timeoutMs)
    timer.unref?.()
    const onResponse = (chunk: Buffer): void => {
      // Any status line is proof of a round trip: the account endpoint answers 401 without a token
      // and `/` answers its own thing. Reaching the server is the question; a credential never is.
      if (!chunk.toString('latin1').startsWith('HTTP/1.')) { fail(new Error('path proof answered garbage')); return }
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve()
    }
    const onError = (error: Error): void => { clearTimeout(timer); reject(error) }
    socket.once('secureConnect', () => {
      socket.on('data', onResponse)
      socket.write('GET / HTTP/1.1' + CRLF + 'Host: ' + host + CRLF + 'Connection: close' + CRLF + CRLF)
    })
    socket.on('error', onError)
  })
}

/**
 * Prove the raw path can finish a round trip before a client is committed to it.
 *
 * Why a TCP connect is not enough: the boot failure in the user's own window was `read ECONNRESET`
 * AFTER the TLS handshake, so a path that "connected" was precisely the path that then died. Requiring
 * one status line covers DNS, TCP, TLS and the request the client is about to make.
 *
 * Why this is NOT a single launch-time probe: that would ask ONCE and freeze the whole session to the
 * answer, and on a per-connection-random path one success is a false positive (in the user's window
 * three raw requests answered 200 while four died in the same batch). Here the same measurement is
 * made per connection, and a failure costs a retry rather than the session.
 *
 * Non-TLS ports skip it: a handshake to something that is not HTTPS would call a working path broken.
 */
export async function proveDirectPath(plan: TunnelPlan, target: TunnelTarget, timeoutMs: number, dial: Dial = dialSocket): Promise<void> {
  if (target.port !== TLS_PORT) return
  const socket = await dial(plan.host, plan.port, Math.max(1, timeoutMs))
  try { await proveTlsRoundTrip(target.host, socket, Math.max(1, timeoutMs)) }
  finally { try { socket.destroy() } catch { /* gone */ } }
}

/**
 * Prove the direct path, and share a PROVEN path with the burst for one short window.
 *
 * Why a cache at all: the account plugin fires several requests in the same instant, and proving on
 * each one would add a full handshake to every request - roughly 100-400ms on the ordinary
 * no-proxy day, which is a cost the user did not ask for. The window is short on purpose: the proof
 * is worth exactly as much as its freshness, and a path that goes bad mid-session is caught by the
 * next burst rather than never.
 *
 * ONLY SUCCESS IS CACHED. Round 41's real boot log priced the alternative: a request that needed
 * its second direct try reported `direct=fail(connect timeout) direct=fail(connect timeout
 * (cached))` - the retry never touched the network - while a sibling connection in the same instant
 * got `up 838ms direct=ok`. The fault defended against here is per-connection randomness, so a
 * cached NO is a claim about a connection that has not been made, and it silently turned
 * DIRECT_ATTEMPTS into the decoration this module was written to remove.
 */
export function createPathProver(proof: Proof = proveDirectPath, ttlMs: number = PROOF_CACHE_MS): Prover {
  const answers = new Map<string, number>()
  return async (plan, target, timeoutMs) => {
    if (target.port !== TLS_PORT) return
    const key = plan.host + ':' + String(plan.port) + ':' + target.host + ':' + String(target.port)
    const freshUntil = answers.get(key)
    if (freshUntil !== undefined && Date.now() < freshUntil) return
    await proof(plan, target, timeoutMs)
    answers.set(key, Date.now() + ttlMs)
  }
}

/** What one accepted connection did, for the log and for tests. */
export type TunnelResult = { readonly target: string, readonly attempts: readonly TunnelAttempt[], readonly ok: boolean, readonly ms: number }

/**
 * Report each connection once, as a line of stderr (the journal is how this app is observed).
 *
 * Only the target host:port and the outcome are carried. A CONNECT carries no credential and the
 * tunnel never terminates the client's TLS, so there is nothing to redact — but the shape is fixed
 * here so a later change cannot quietly turn the log into a leak (red line 3).
 */
export type TunnelLogger = (result: TunnelResult) => void

/**
 * Handle one client connection: read its CONNECT line, then choose a path for it.
 *
 * Separate from the listener so the whole decision is testable without a real proxy, and so a
 * malformed first line cannot take the server down.
 */
export function serveTunnelConnection(
  client: Socket,
  upstream: UpstreamProbe,
  prove: Prover,
  dial: Dial = dialSocket,
  log: TunnelLogger = () => {},
  budgetMs: number = CONNECT_BUDGET_MS,
): void {
  const started = Date.now()
  let pending = Buffer.alloc(0)
  let settled = false
  const giveUp = (): void => {
    if (settled) return
    settled = true
    client.write(BAD_502, 'latin1')
    client.end()
  }
  // A client waiting on a tunnel says nothing until it is answered, so nothing here may be held open
  // indefinitely: not a silent client, and not a path that is quietly eating the socket.
  const deadline = setTimeout(giveUp, budgetMs)
  deadline.unref?.()
  const stop = (): void => { clearTimeout(deadline) }
  client.on('error', () => { stop(); try { client.destroy() } catch { /* gone */ } })
  client.on('close', stop)
  client.on('data', (chunk: Buffer) => {
    if (settled) return
    pending = Buffer.concat([pending, chunk])
    // A client that never finishes a header line must not be able to grow this without bound.
    if (pending.length > 16_384) { giveUp(); stop(); return }
    const end = pending.indexOf(HEADER_END)
    if (end < 0) return
    const firstLine = pending.subarray(0, pending.indexOf(CRLF_BYTES)).toString('latin1')
    // Bytes the client put in the SAME packet as the CONNECT headers belong to the tunnelled
    // stream. A client is allowed to send them, so they must be forwarded, not parsed and not
    // dropped: dropping them silently corrupts the first request on that connection.
    const forOrigin = pending.subarray(end + 4)
    settled = true
    stop()
    const target = parseConnectTarget(firstLine)
    if (target === null) {
      // An absolute-form request (a plain http:// client through a proxy) is refused rather than
      // guessed at: this tunnel promises only TLS pass-through, and only CONNECT needs that.
      if (isPlainRequest(firstLine)) { client.write(NOT_405, 'latin1'); client.end(); return }
      client.destroy()
      return
    }
    // `void` because a CONNECT is answered or refused, never awaited by the caller - but an
    // unexpected throw inside it must not become an unhandled rejection in the main process, which
    // is the process holding the user's window. Refusing the connection is always available.
    void pipeThroughAttempts(client, target, forOrigin, upstream, prove, dial, log, budgetMs, started)
      .catch(() => {
        try { client.write(BAD_502, 'latin1'); client.end() } catch { /* already gone */ }
      })
  })
}

/**
 * Try the planned paths until one tunnels, then pipe bytes both ways.
 *
 * Piping is raw: TLS stays end-to-end between the host and the origin, so this process never holds
 * or sees a token.
 */
async function pipeThroughAttempts(
  client: Socket,
  target: TunnelTarget,
  forOrigin: Buffer,
  upstream: UpstreamProbe,
  prove: Prover,
  dial: Dial,
  log: TunnelLogger,
  budgetMs: number,
  started: number,
): Promise<void> {
  const attempts: TunnelAttempt[] = []
  // Re-read the budget before EVERY attempt: the plan was drawn up earlier, and one slow probe or
  // dial must not be able to push the total past what the client is sitting waiting for.
  const remaining = (): number => Math.max(0, budgetMs - (Date.now() - started))
  let proxy: SystemProxy | null = null
  try { proxy = await upstream() } catch { proxy = null }
  for (const plan of planAttempts(proxy, target)) {
    const left = remaining()
    if (left <= 0) { attempts.push({ path: plan.path, ok: false, note: 'budget spent' }); break }
    const timeout = Math.min(plan.attemptMs, left)
    if (plan.path === 'direct') {
      // Prove the round trip first, then hand the client a FRESH socket. A fresh one because a TLS
      // session a proof already used cannot be passed on, and because buffering the client's bytes to
      // replay them would mean holding traffic this tunnel must not read. The cost is one extra
      // handshake (measured here at ~100ms), shared across a burst by the prover's cache; the
      // alternative is the stall itself.
      try { await prove(plan, target, timeout) }
      catch (error) {
        attempts.push({ path: plan.path, ok: false, note: error instanceof Error ? error.message : String(error) })
        continue
      }
      const leftAgain = remaining()
      if (leftAgain <= 0) { attempts.push({ path: plan.path, ok: false, note: 'budget spent after proof' }); break }
      let socket: Socket
      try { socket = await dial(plan.host, plan.port, Math.min(timeout, leftAgain)) }
      catch (error) {
        attempts.push({ path: plan.path, ok: false, note: error instanceof Error ? error.message : String(error) })
        continue
      }
      attempts.push({ path: plan.path, ok: true, note: 'proved' })
      client.write(OK_200, 'latin1')
      log({ target: target.host + ':' + String(target.port), attempts, ok: true, ms: Date.now() - started })
      pipe(client, socket, EMPTY, forOrigin)
      return
    }
    // A proxy hop: dial it, ask it for the same tunnel, and only then accept the client's. Its
    // liveness was already proven CONNECT+TLS by `usableLocalProxy` inside the cache window, so this
    // hop is a dial plus one status line, not another handshake.
    let hop: Socket
    try { hop = await dial(plan.host, plan.port, timeout) }
    catch (error) {
      attempts.push({ path: plan.path, ok: false, note: error instanceof Error ? error.message : String(error) })
      continue
    }
    const leftForHello = remaining()
    if (leftForHello <= 0) {
      try { hop.destroy() } catch { /* gone */ }
      attempts.push({ path: plan.path, ok: false, note: 'budget spent' })
      break
    }
    const hello = await waitForProxyHello(hop, target, Math.min(timeout, leftForHello))
    if (!hello.ok) {
      try { hop.destroy() } catch { /* gone */ }
      attempts.push({ path: plan.path, ok: false, note: 'upstream refused CONNECT' })
      continue
    }
    attempts.push({ path: plan.path, ok: true, note: '' })
    client.write(OK_200, 'latin1')
    log({ target: target.host + ':' + String(target.port), attempts, ok: true, ms: Date.now() - started })
    // `extra` is whatever the hop already received past its own status line; it belongs to the client.
    pipe(client, hop, hello.extra, forOrigin)
    return
  }
  log({ target: target.host + ':' + String(target.port), attempts, ok: false, ms: Date.now() - started })
  client.write(BAD_502, 'latin1')
  client.end()
}

/** Bridge client and next hop, tearing both down together, parsing nothing that passes through. */
function pipe(client: Socket, origin: Socket, fromOrigin: Buffer = EMPTY, toOrigin: Buffer = EMPTY): void {
  const closeBoth = (): void => {
    try { origin.destroy() } catch { /* gone */ }
    try { client.destroy() } catch { /* gone */ }
  }
  // Each side's already-received bytes travel first, in the direction they arrived: the client's
  // before the origin starts answering, the origin's before the client reads them.
  if (toOrigin.length > 0) origin.write(toOrigin)
  if (fromOrigin.length > 0) client.write(fromOrigin)
  // Backpressure, or a fast origin overruns a slow client and a stalled client pins memory for as
  // long as the connection lives.
  client.on('data', (chunk: Buffer) => { if (!origin.write(chunk)) { client.pause(); origin.once('drain', () => client.resume()) } })
  origin.on('data', (chunk: Buffer) => { if (!client.write(chunk)) { origin.pause(); client.once('drain', () => origin.resume()) } })
  client.on('end', () => { try { origin.end() } catch { /* gone */ } })
  origin.on('end', () => { try { client.end() } catch { /* gone */ } })
  client.on('error', closeBoth)
  origin.on('error', closeBoth)
  client.on('close', closeBoth)
  origin.on('close', closeBoth)
}

/** The running tunnel, with the port it actually got. */
export type Tunnel = { readonly port: number, readonly server: Server, close(): Promise<void> }

/**
 * Listen on loopback for the host's CONNECT requests.
 *
 * @param probe - asks the machine for an upstream proxy; expected to be a {@link cacheUpstream} wrap.
 * @returns the listener and its port, which is what goes into the child's `https_proxy`.
 */
export async function startTunnel(
  probe: UpstreamProbe,
  dial: Dial = dialSocket,
  log: TunnelLogger = () => {},
  budgetMs: number = CONNECT_BUDGET_MS,
): Promise<Tunnel> {
  const prove = createPathProver((plan, target, timeoutMs) => proveDirectPath(plan, target, timeoutMs, dial))
  const live = new Set<Socket>()
  const server = createServer((client) => {
    live.add(client)
    client.on('close', () => { live.delete(client) })
    serveTunnelConnection(client, probe, prove, dial, log, budgetMs)
  })
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(error)
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('tunnel did not get a TCP port')
  return {
    port: address.port,
    server,
    close: () => new Promise<void>((resolve) => {
      // node:net has no closeAllConnections (that is http.Server), and an open tunnel would
      // otherwise hold `close` until the client hung up — the long-lived case for exactly this host.
      for (const socket of live) { try { socket.destroy() } catch { /* gone */ } }
      live.clear()
      server.close(() => resolve())
    }),
  }
}
