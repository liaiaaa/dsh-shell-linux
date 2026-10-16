/**
 * Environment massaging for the host child process.
 *
 * Two knobs, both scoped to that one child and never to the machine:
 *
 * 1. Proxy. A dead proxy poisons every account API call (`platform.deepseek.com` reports
 *    `errorCode: 'network'` even when direct connectivity is fine - see the README's
 *    known-limitations note). `DSH_DESKTOP_NO_PROXY=1` drops all proxy variables
 *    (both cases, all flavors) before they reach the host; the default passes the
 *    environment through untouched.
 *
 * 2. Name resolution. The stall measured here is a glibc `getaddrinfo` that waits out its
 *    default five-second timeout while the same name answers in 1-14ms through c-ares at the
 *    same instant (probe/ui-polish/host-net-hook.cjs; see the ledger). Node resolves
 *    `net.connect` targets on a libuv thread via getaddrinfo, and an AbortSignal cannot cancel
 *    that, which is why the account plugin's own 30s/3s timeout never cut the wait either.
 *    Following a proxy hid the problem by accident: a proxy address is a literal IP, so the
 *    critical path does no resolving at all. `RES_OPTIONS=timeout:1` shortens the DIRECT path's
 *    wait too, and needs no proxy running.
 */

import { isExplicitProxy, parseProxyUrl, withSystemProxy, type SystemProxy } from './system-proxy.ts'

const PROXY_VARS = [
  'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'rsync_proxy',
  'no_proxy',
] as const

/**
 * Resolver budget for the host child: one second per attempt instead of glibc's five, still two
 * attempts so a genuinely transient loss keeps its retry. glibc reads this per process and no
 * other library does, so the blast radius is this one child.
 */
export const HOST_RES_OPTIONS = 'timeout:1 attempts:2'

/**
 * Worker threads available to the host child for name resolution.
 *
 * getaddrinfo runs on libuv's thread pool, which defaults to FOUR workers, and a queued lookup
 * cannot be canceled: boot fires several platform requests at once, each stalled lookup holds a
 * worker, and the timeout error only surfaces once the queue drains. That is what was measured
 * (a 30s AbortSignal.timeout surfacing at 65s), so raising the pool matters as much as
 * shortening each lookup. The cost is a handful of idle threads in one child process.
 */
export const HOST_UV_THREADPOOL_SIZE = '16'

/**
 * Apply the resolver budget and the pool size, leaving any value the user already set alone.
 *
 * Takes the child's own environment, which is already a copy of the inherited one, so a
 * RES_OPTIONS or UV_THREADPOOL_SIZE the user exported arrives through the copy untouched.
 *
 * @param environment - the child environment being built (mutated and returned).
 */
export function withNetworkTuning(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (blankOrUnset(environment.RES_OPTIONS)) environment.RES_OPTIONS = HOST_RES_OPTIONS
  if (blankOrUnset(environment.UV_THREADPOOL_SIZE)) environment.UV_THREADPOOL_SIZE = HOST_UV_THREADPOOL_SIZE
  return environment
}

function blankOrUnset(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

export function buildHostEnv(source: NodeJS.ProcessEnv, noProxy: boolean): NodeJS.ProcessEnv {
  if (!noProxy) return { ...source }
  const stripped = { ...source }
  for (const name of PROXY_VARS) {
    delete stripped[name]
    delete stripped[name.toUpperCase()]
  }
  return stripped
}

/**
 * The host child's proxy decision, as one pure function so the precedence is unit-testable
 * (the main process is not reachable by the CDP harness, so it cannot be asserted at runtime).
 *
 * Every branch also gains the resolver timeout: the branches that stay direct are exactly the
 * ones where name resolution sits on the critical path.
 *
 * @param source - inherited environment.
 * @param mode - `DSH_DESKTOP_SYSTEM_PROXY`: unset/`auto` follows only a verified system proxy;
 *               `0`/`off` never follows; `1`/`on` requires one (and says so when absent).
 * @param noProxy - `DSH_DESKTOP_NO_PROXY` won: strip everything, stay direct, ignore the panel.
 * @param system - the verified proxy to route through (always loopback), or null when there is none.
 * @param options.via - what `system` is, in the log line: the shell's tunnel or a named proxy.
 */
export function hostProxyEnvironment(options: {
  source: NodeJS.ProcessEnv, mode: string, noProxy: boolean, apply: (env: NodeJS.ProcessEnv, proxy: SystemProxy) => NodeJS.ProcessEnv,
  via?: string,
}, system: SystemProxy | null): { env: NodeJS.ProcessEnv, note: string | null } {
  const { source, mode, noProxy } = options
  if (noProxy) return { env: withNetworkTuning(buildHostEnv(source, true)), note: '[dsh-shell-linux] host DIRECT (NO_PROXY)' }
  if (mode === '0' || mode === 'off') return { env: withNetworkTuning({ ...source }), note: '[dsh-shell-linux] host DIRECT (follow disabled)' }
  if (system !== null) {
    return {
      env: withNetworkTuning(options.apply({ ...source }, system)),
      // The caller says what this address IS, because the same field carries two different things
      // (the shell's own tunnel on a random port, or a proxy the user named) and guessing from the
      // port number is exactly the kind of inference that reads a log line wrong. Round 39's reading
      // went looking for an xray that was never in the loop.
      note: `[dsh-shell-linux] host outbound HTTPS via ${options.via ?? 'proxy'} ` +
        `http://${system.host}:${String(system.port)} (loopback bypassed)`,
    }
  }
  if (mode === '1' || mode === 'on') return { env: withNetworkTuning({ ...source }), note: '[dsh-shell-linux] no usable proxy; host connects directly' }
  return { env: withNetworkTuning({ ...source }), note: '[dsh-shell-linux] host DIRECT (nothing to route through)' }
}

/**
 * What to do about the host's outbound route, as one pure decision.
 *
 * Extracted from the main process because the main process is not reachable by the CDP harness (see
 * runtime), and this is exactly the precedence that must be tested rather than eyeballed: an
 * environment switch that silently stopped working would leave the user on the stalling path.
 *
 * @param mode - the `DSH_DESKTOP_SYSTEM_PROXY` value (mode word or explicit proxy URL).
 * @param noProxy - `DSH_DESKTOP_NO_PROXY` won.
 * @returns `direct` - do not intercept anything; the child launches exactly as it did before the
 *          tunnel existed. `tunnel` - start the shell tunnel and point the child at it, with
 *          `explicit` pinned when the user named one URL.
 *
 * An explicit value that cannot be parsed stays `direct` rather than becoming a search: the promise
 * made to users was that a named proxy is an order, and silently discovering some other
 * listener would route the account calls through something the user never named.
 */
export type HostRoute = { kind: 'direct', reason: string } | { kind: 'tunnel', explicit: SystemProxy | null }

export function planHostRoute(mode: string, noProxy: boolean): HostRoute {
  if (noProxy) return { kind: 'direct', reason: 'DSH_DESKTOP_NO_PROXY' }
  if (mode === '0' || mode === 'off' || mode === 'false') return { kind: 'direct', reason: 'follow disabled' }
  if (!isExplicitProxy(mode)) return { kind: 'tunnel', explicit: null }
  const explicit = parseProxyUrl(mode)
  if (explicit === null) return { kind: 'direct', reason: 'named proxy URL is not usable' }
  return { kind: 'tunnel', explicit }
}
