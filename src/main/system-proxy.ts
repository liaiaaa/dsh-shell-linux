/**
 * Find a proxy on this machine that can ACTUALLY tunnel, and say so in a form the host can use.
 *
 * What this module no longer does: decide the route. The shell's own CONNECT tunnel
 * (`src/main/tunnel.ts`) asks this question per connection, because a decision made at launch froze
 * the whole session to one sample of a path that fails per connection. What remains here is the
 * discovery half, which the tunnel calls: the panel's proxy first, then discovered loopback
 * listeners, each verified by a real CONNECT plus a TLS handshake through it.
 *
 * Why a proxy at all: the DSH host is a standalone `node` process,
 * and Node does NOT read the GNOME system proxy - it reads `http(s)_proxy` only, which the desktop
 * launcher never sets. So the browser reaches `platform.deepseek.com` through xray while the host
 * dials it raw, and the raw dial intermittently waits ~40s or dies `read ECONNRESET`. Proxy-routed
 * requests measured 164-545ms in the same window.
 *
 * Deliberately conservative: a proxy variable naming a
 * port that cannot serve CONNECT makes every account API fail with `errorCode: 'network'` while the
 * link is fine. So:
 *  - only a listener that completes CONNECT *and* TLS through the tunnel is trusted - a 200 status
 *    line alone proves nothing, because xray answers 200 before it resolves the name;
 *  - loopback is always bypassed, so the shell's own token->cookie exchange and every RPC cannot be
 *    routed back through a proxy and form a loop;
 *  - only `https_proxy` is set: every affected endpoint is HTTPS, and leaving `http_proxy` alone
 *    keeps the blast radius at the failure that was measured.
 */
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

/** Type of the socket pair a CONNECT probe may need to clean up. */
type ProbeSocket = { removeAllListeners(): void; destroy(): void }

const CRLF = String.fromCharCode(13, 10)

/** The GNOME key this feature reads. Nothing else on the system is consulted or written. */
export const GSETTINGS_SCHEMA = 'org.gnome.system.proxy'

/**
 * How long to wait, at most, for the panel's proxy to start listening (ms).
 *
 * Measured on this machine at boot (from the user's own window, via the journal): dsh was ready at
 * 07:26:48 while xray only came up at 07:26:59, and the panel already said `manual` from the
 * previous session. Deciding once at that instant called the proxy unusable, committed the whole
 * session to the raw path, and the account requests died 13 seconds later with `read ECONNRESET`.
 * DSH_DESKTOP_SYSTEM_PROXY=0 skips the wait entirely for anyone who wants the raw path at once.
 */
export const WAIT_FOR_PROXY_MS = 2000

export type SystemProxy = { readonly host: string, readonly port: number }

/** True when a host string is a literal loopback address — the only thing we accept for a proxy. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Parse the pieces of `gsettings` output this decision needs.
 *
 * @param values - `mode`, `http host`, `http port`, each as gsettings prints it (quoted strings).
 * @returns the proxy to use, or null when the desktop is off/auto/unreadable or names something
 *          other than a loopback http proxy — every rejection means "stay direct".
 */
export function parseSystemProxy(values: { mode: string, host: string, port: string } | null): SystemProxy | null {
  if (values === null) return null
  const mode = unquote(values.mode)
  if (mode !== 'manual') return null
  const host = unquote(values.host)
  const port = Number(unquote(values.port))
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  // A remote proxy in the GNOME panel is not this machine's browser path, and trusting it would
  // send the host's traffic somewhere the user never pointed a terminal process at.
  if (!isLoopbackHost(host)) return null
  return { host, port }
}

function unquote(raw: string): string { return raw.trim().replace(/^'(.*)'$/su, '$1').replace(/^"(.*)"$/su, '$1') }

/**
 * Can a TCP connection be established to `host:port` within `timeoutMs`?
 *
 * @returns true only on a real handshake. Every error (ECONNREFUSED, ENETUNREACH, ...) and every
 *          timeout is false: "unknown" must never become "trust it and proxy".
 */
export function portIsListening(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const settle = (answer: boolean): void => { socket.removeAllListeners(); socket.destroy(); resolve(answer) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * The environment for the host child when it should reach the network through a proxy.
 *
 * In the shipped shell the value handed here is the shell's OWN tunnel, so this writes
 * `https_proxy=http://127.0.0.1:<tunnel>`; the tunnel then decides per connection whether to chain
 * to a discovered proxy or go direct.
 *
 * @param source - the inherited environment.
 * @param proxy - the verified system proxy.
 * @returns a copy carrying `https_proxy` + `NODE_USE_ENV_PROXY`, with loopback bypassed in both
 *          casings of `no_proxy`. Existing proxy variables win untouched (an explicit user export
 *          or `DSH_DESKTOP_NO_PROXY=1` stripping is the user's decision, not ours).
 */
export function withSystemProxy(source: NodeJS.ProcessEnv, proxy: SystemProxy): NodeJS.ProcessEnv {
  if (source.https_proxy !== undefined || source.HTTPS_PROXY !== undefined) return { ...source }
  const bypass = 'localhost,127.0.0.1,::1,[::1]'
  const existing = source.no_proxy ?? source.NO_PROXY
  const list = existing === undefined || existing.trim() === '' ? bypass : `${existing.trim()},${bypass}`
  return {
    ...source,
    https_proxy: `http://${proxy.host}:${String(proxy.port)}`,
    NODE_USE_ENV_PROXY: '1',
    no_proxy: list,
    NO_PROXY: list,
  }
}


/**
 * Wait for a proxy port to answer, up to budgetMs.
 *
 * @param proxy - the manual proxy the panel names.
 * @param budgetMs - the bound. A user who really left the proxy off pays only this much, once, at
 *                   startup; the host still gets the direct path afterwards.
 * @param probe - the listening check, injected for tests.
 * @param wait - the delay between polls, injected for tests.
 * @returns the proxy once it answers, or null when the budget runs out.
 */
export async function waitForProxy(
  proxy: SystemProxy,
  budgetMs: number,
  probe: (host: string, port: number) => Promise<boolean> = portIsListening,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SystemProxy | null> {
  const step = 250
  let spent = 0
  while (true) {
    if (await probe(proxy.host, proxy.port)) return proxy
    if (spent >= budgetMs) return null
    await wait(step)
    spent += step
  }
}

/**
 * Read the machine's proxy policy the way a desktop app is expected to: the GNOME panel settings.
 *
 * @param run - injected `gsettings get <schema> <key>` for tests.
 * @returns the verified proxy, or null meaning "stay direct".
 */
export async function resolveSystemProxy(
  run: (schema: string, key: string) => Promise<string> = gsettingsGet,
  listening: (host: string, port: number) => Promise<boolean> = portIsListening,
  budgetMs: number = WAIT_FOR_PROXY_MS,
): Promise<SystemProxy | null> {
  const grab = async (schema: string, key: string): Promise<string> => {
    try { return await run(schema, key) } catch { return '' }
  }
  const mode = await grab('org.gnome.system.proxy', 'mode')
  if (unquote(mode) !== 'manual') return null
  // GNOME has no `enabled` key on the https section (only http does), and a panel configured for
  // https-only is exactly the case here, so the https row is authoritative and http is the fallback.
  const host = unquote(await grab('org.gnome.system.proxy.https', 'host')) || unquote(await grab('org.gnome.system.proxy.http', 'host'))
  const rawPort = unquote(await grab('org.gnome.system.proxy.https', 'port')) || unquote(await grab('org.gnome.system.proxy.http', 'port'))
  const proxy = parseSystemProxy({ mode, host, port: rawPort })
  if (proxy === null) return null
  // The panel names a manual loopback proxy, so the intent is a proxy: give it a bounded chance to
  // appear instead of committing this session to the direct path on the very first miss.
  return waitForProxy(proxy, budgetMs, listening)
}

/** `gsettings get <schema> <key>`, bounded: a hung dbus call must never delay the host launch. */
export function gsettingsGet(schema: string, key: string, timeoutMs = 1_500): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('gsettings', ['get', schema, key], { timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout) => { if (error !== null) reject(error); else resolve(stdout) })
    child.once('error', reject)
  })
}

/**
 * Parse an explicitly configured proxy URL (`DSH_DESKTOP_SYSTEM_PROXY=http://host:port`).
 *
 * Only `http:`/`https:` are accepted: undici's env proxy cannot use a SOCKS URL, and silently
 * handing the host a `socks5://` value would leave it direct while claiming otherwise (the same
 * reason DSH's own proxy layer reports SOCKS instead of borrowing another scheme).
 *
 * @returns the proxy to verify, or null when the value is not a usable http(s) proxy URL.
 */
export function parseProxyUrl(value: string): SystemProxy | null {
  const raw = value.trim()
  if (raw === '') return null
  const parsed = URL.parse(raw.includes('://') ? raw : `http://${raw}`)
  if (parsed === null || !['http:', 'https:'].includes(parsed.protocol)) return null
  const host = parsed.hostname
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'))
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

/** Whether a `DSH_DESKTOP_SYSTEM_PROXY` value names a proxy directly instead of a mode word. */
export function isExplicitProxy(value: string): boolean {
  return !['', 'auto', '0', '1', 'on', 'off', 'true', 'false'].includes(value.trim().toLowerCase())
}

/**
 * Loopback ports probed for a working proxy when the desktop panel names none.
 *
 * Why discovery is needed: v2rayN's "system proxy" switch only rewrites the GNOME panel. With the
 * switch off the panel reads `none`, so following the panel leaves the host on the raw path, and
 * the raw path is what stalls on this machine (measured in the user's OWN window: requests issued
 * at 07:26:49 died `aborted: true` at 07:27:02 - ~13 seconds, the shape of TCP SYN retransmit
 * backoff, and already carrying the RES_OPTIONS/UV_THREADPOOL mitigations). xray itself was
 * listening on 10808 the whole time. These are the ports proxy clients on Linux conventionally use.
 */
export const PROXY_CANDIDATE_PORTS = [10808, 10809, 7890, 7897, 8118, 8888, 1087, 33210] as const

/**
 * Can this port act as an HTTP CONNECT proxy for the origin that matters?
 *
 * A listening port is not enough: a SOCKS-only listener answers garbage to CONNECT, and handing
 * that to undici reproduces the same failure (every account call dies with `errorCode: network`).
 * So the probe sends a real CONNECT to the account host, without a token or credential, and
 * requires `200 Connection established` before the proxy is trusted.
 *
 * @param probeHost - the target the CONNECT asks for; the account origin by default.
 */
export function proxyCanConnect(
  proxy: SystemProxy,
  probeHost = PROBE_ORIGIN,
  timeoutMs = 2500,
): Promise<boolean> {
  return new Promise((resolve) => {
    // A probe answers yes or no, it never throws: an out-of-range port rejecting all the way up
    // through resolveProxyForMode would take the window down over a diagnostic check.
    let plain: ReturnType<typeof createConnection>
    try {
      plain = createConnection({ host: proxy.host, port: proxy.port })
    } catch {
      resolve(false)
      return
    }
    let tunnel: TLSSocket | undefined
    // Tear down only the outermost socket. Stripping listeners off the plain socket once the TLS
    // client owns it deletes Node's own internal handlers, which segfaults the process (measured:
    // a second probe in the same process crashed with SIGSEGV and left a core dump). Destroying
    // the TLSSocket closes the socket it wrapped, so nothing leaks either way.
    const settle = (answer: boolean): void => {
      const socket: ProbeSocket = tunnel ?? plain
      try { socket.destroy() } catch { /* gone */ }
      resolve(answer)
    }
    plain.setTimeout(timeoutMs)
    plain.on('timeout', () => settle(false))
    plain.on('error', () => settle(false))
    let head = ''
    plain.on('connect', () => {
      plain.write('CONNECT ' + probeHost + ':443 HTTP/1.1' + CRLF + 'Host: ' + probeHost + ':443' + CRLF + CRLF)
    })
    plain.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1')
      if (head.indexOf(CRLF + CRLF) < 0) return
      plain.removeAllListeners('data')
      if (!/^HTTP\/1\.[01] 200\b/u.test(head)) { settle(false); return }
      // A 200 alone proves nothing: xray answers `200 Connection established` BEFORE it resolves
      // the name (measured: a CONNECT to a bogus host returns 200, then dies with ECONNRESET after
      // ~1s), and any local HTTP server would answer a status line too. Trusting either would put
      // the host's HTTPS behind a non-proxy, which is the failure this probe exists to prevent. So finish the
      // handshake the account calls actually need: TLS to the real origin through the tunnel.
      // Cost on this machine is 72ms when it works.
      tunnel = tlsConnect({ socket: plain, servername: probeHost })
      tunnel.setTimeout(timeoutMs)
      tunnel.once('secureConnect', () => settle(true))
      tunnel.on('timeout', () => settle(false))
      tunnel.on('error', () => settle(false))
    })
  })
}

/**
 * The best proxy this machine can actually use, panel first, then discovered listeners.
 *
 * @param panel - the proxy the desktop panel names (already verified listening), or null.
 * @param candidates - loopback ports to try when the panel names nothing.
 * @param canConnect - the CONNECT probe, injected for tests.
 */
export async function usableLocalProxy(
  panel: SystemProxy | null,
  candidates: readonly number[] = PROXY_CANDIDATE_PORTS,
  canConnect: (proxy: SystemProxy) => Promise<boolean> = proxyCanConnect,
  listening: (host: string, port: number) => Promise<boolean> = portIsListening,
): Promise<SystemProxy | null> {
  // A panel proxy that is listening but cannot CONNECT (a SOCKS-only listener, say) is worse than
  // useless here, so keep looking instead of handing it to undici and repeating that failure.
  if (panel !== null && await canConnect(panel)) return panel
  for (const port of candidates) {
    const proxy = { host: '127.0.0.1', port }
    // Listening first: a CONNECT probe against a closed port would just burn its timeout, and on a
    // machine with no proxy at all this whole loop should cost almost nothing.
    if (await listening(proxy.host, proxy.port) && await canConnect(proxy)) return proxy
  }
  return null
}

/** The origin a proxy is verified against; the account plugin calls exactly this host. */
export const PROBE_ORIGIN = 'platform.deepseek.com'
