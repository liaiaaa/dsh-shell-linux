import { describe, expect, it } from 'vitest'
import { buildHostEnv, HOST_RES_OPTIONS, HOST_UV_THREADPOOL_SIZE, hostProxyEnvironment, withNetworkTuning } from '../src/main/env.ts'
import { withSystemProxy } from '../src/main/system-proxy.ts'

describe('buildHostEnv', () => {
  it('passes the environment through untouched by default', () => {
    const source = { PATH: '/usr/bin', https_proxy: 'http://127.0.0.1:10808', no_proxy: 'localhost' }
    expect(buildHostEnv(source, false)).toEqual(source)
  })
  it('strips every proxy variable when noProxy is set', () => {
    const source = {
      PATH: '/usr/bin',
      http_proxy: 'http://127.0.0.1:10808',
      https_proxy: 'http://127.0.0.1:10808',
      HTTP_PROXY: 'http://127.0.0.1:10808',
      HTTPS_PROXY: 'http://127.0.0.1:10808',
      all_proxy: 'socks5://127.0.0.1:10808',
      ALL_PROXY: 'socks5://127.0.0.1:10808',
      no_proxy: 'localhost,127.0.0.1',
      NO_PROXY: 'localhost,127.0.0.1',
    }
    const env = buildHostEnv(source, true)
    expect(env).toEqual({ PATH: '/usr/bin' })
    expect(Object.keys(env).filter(key => key.toLowerCase().includes('proxy'))).toEqual([])
  })
  it('keeps unrelated variables case-sensitively intact', () => {
    const source = { DSH_HOST_DEBUG: '1', PATH: '/bin' }
    expect(buildHostEnv(source, true)).toEqual({ DSH_HOST_DEBUG: '1', PATH: '/bin' })
  })
})

describe('hostProxyEnvironment', () => {
  const proxy = { host: '127.0.0.1', port: 10808 }
  const base = { PATH: '/usr/bin' }
  const opts = (mode: string, noProxy = false) => ({ source: base, mode, noProxy, apply: withSystemProxy })

  it('gives every branch the resolver budget and pool size, proxy or not', () => {
    for (const [mode, system] of [['auto', proxy], ['auto', null], ['0', proxy], ['1', null]] as const) {
      const { env } = hostProxyEnvironment(opts(mode), system)
      expect(env.RES_OPTIONS).toBe(HOST_RES_OPTIONS)
      expect(env.UV_THREADPOOL_SIZE).toBe(HOST_UV_THREADPOOL_SIZE)
    }
    expect(hostProxyEnvironment(opts('auto', true), proxy).env.RES_OPTIONS).toBe(HOST_RES_OPTIONS)
  })
  it('follows a verified system proxy in auto mode and explains it', () => {
    const { env, note } = hostProxyEnvironment(opts('auto'), proxy)
    expect(env.https_proxy).toBe('http://127.0.0.1:10808')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    expect(env.no_proxy).toContain('127.0.0.1')
    expect(note).toContain('proxy http://127.0.0.1:10808')
  })
  // The tunnel listens on a random loopback port, so the address alone cannot say what it is, and a
  // log line that guessed "system proxy http://127.0.0.1:<random>" sent the reader hunting for an
  // xray on a port that never had one. The caller now states it.
  it('names the shell tunnel when the caller says that is what the address is', () => {
    const tunnelProxy = { host: '127.0.0.1', port: 43147 }
    const optsVia = { source: base, mode: 'auto', noProxy: false, apply: withSystemProxy, via: 'shell tunnel, per-connection route' }
    const { note } = hostProxyEnvironment(optsVia, tunnelProxy)
    expect(note).toContain('shell tunnel, per-connection route http://127.0.0.1:43147')
    expect(note).not.toContain('system proxy')
  })
  it('auto with no system proxy stays exactly as inherited (the default path is unchanged)', () => {
    const { env, note } = hostProxyEnvironment(opts('auto'), null)
    expect(withoutTuning(env)).toEqual(base)
    expect(note).toContain('host DIRECT')
  })
  it('mode 0/off never follows', () => {
    for (const mode of ['0', 'off']) {
      expect(hostProxyEnvironment(opts(mode), proxy).env.https_proxy).toBeUndefined()
    }
  })
  it('mode 1/on without a usable proxy says so and stays direct', () => {
    const { env, note } = hostProxyEnvironment(opts('1'), null)
    expect(env.https_proxy).toBeUndefined()
    expect(note).toContain('no usable proxy')
  })
  it('DSH_DESKTOP_NO_PROXY wins over the panel', () => {
    const source = { PATH: '/usr/bin', https_proxy: 'http://127.0.0.1:10808' }
    const { env } = hostProxyEnvironment({ source, mode: 'auto', noProxy: true, apply: withSystemProxy }, proxy)
    expect(withoutTuning(env)).toEqual({ PATH: '/usr/bin' })
  })
})

describe('withNetworkTuning', () => {
  it('sets both when the environment names neither', () => {
    const env = withNetworkTuning({})
    expect(env.RES_OPTIONS).toBe(HOST_RES_OPTIONS)
    expect(env.UV_THREADPOOL_SIZE).toBe(HOST_UV_THREADPOOL_SIZE)
  })
  it('keeps values the inherited environment already carries', () => {
    expect(withNetworkTuning({ RES_OPTIONS: 'timeout:8' }).RES_OPTIONS).toBe('timeout:8')
    expect(withNetworkTuning({ UV_THREADPOOL_SIZE: '4' }).UV_THREADPOOL_SIZE).toBe('4')
  })
  it('treats a blank value as unset', () => {
    expect(withNetworkTuning({ RES_OPTIONS: '  ' }).RES_OPTIONS).toBe(HOST_RES_OPTIONS)
    expect(withNetworkTuning({ UV_THREADPOOL_SIZE: '' }).UV_THREADPOOL_SIZE).toBe(HOST_UV_THREADPOOL_SIZE)
  })
})
/** Drop only the two tuning keys, so the assertion is about everything else staying intact. */
function withoutTuning(env) {
  const rest = { ...env }
  delete rest.RES_OPTIONS
  delete rest.UV_THREADPOOL_SIZE
  return rest
}
