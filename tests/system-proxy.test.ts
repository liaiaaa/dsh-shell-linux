import { describe, expect, it } from 'vitest'
import {
  isExplicitProxy, isLoopbackHost, parseProxyUrl, parseSystemProxy, portIsListening,
  proxyCanConnect, resolveSystemProxy, usableLocalProxy, withSystemProxy,
} from '../src/main/system-proxy.ts'

describe('parseSystemProxy', () => {
  it('accepts a manual loopback proxy exactly as gsettings prints it', () => {
    expect(parseSystemProxy({ mode: "'manual'", host: "'127.0.0.1'", port: '10808' }))
      .toEqual({ host: '127.0.0.1', port: 10808 })
  })
  it('rejects anything that is not a loopback manual proxy', () => {
    const bad = [
      null,
      { mode: "'none'", host: "'127.0.0.1'", port: '10808' },
      { mode: "'auto'", host: "'127.0.0.1'", port: '10808' },
      { mode: "'manual'", host: "'proxy.corp.example'", port: '3128' },
      { mode: "'manual'", host: "''", port: '10808' },
      { mode: "'manual'", host: "'127.0.0.1'", port: '0' },
      { mode: "'manual'", host: "'127.0.0.1'", port: '70000' },
      { mode: "'manual'", host: "'127.0.0.1'", port: "''" },
    ]
    for (const values of bad) expect(parseSystemProxy(values)).toBeNull()
  })
})

describe('isLoopbackHost', () => {
  it('recognises the three loopback spellings', () => {
    expect(['127.0.0.1', 'localhost', '::1'].map(isLoopbackHost)).toEqual([true, true, true])
    expect(isLoopbackHost('10.0.0.1')).toBe(false)
  })
})

describe('withSystemProxy', () => {
  const proxy = { host: '127.0.0.1', port: 10808 }
  it('sets https_proxy and enables undici env-proxy, bypassing loopback', () => {
    const env = withSystemProxy({ PATH: '/usr/bin' }, proxy)
    expect(env.https_proxy).toBe('http://127.0.0.1:10808')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    expect(env.no_proxy).toContain('127.0.0.1')
    expect(env.NO_PROXY).toBe(env.no_proxy)
    expect(env.http_proxy).toBeUndefined()
  })
  it('never overwrites a proxy the user exported', () => {
    const env = withSystemProxy({ https_proxy: 'http://127.0.0.1:9999' }, proxy)
    expect(env.https_proxy).toBe('http://127.0.0.1:9999')
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined()
  })
  it('preserves an existing bypass list and appends loopback', () => {
    const env = withSystemProxy({ no_proxy: '.internal.example' }, proxy)
    expect(env.no_proxy).toBe('.internal.example,localhost,127.0.0.1,::1,[::1]')
  })
})

describe('portIsListening', () => {
  it('resolves false for a port nothing listens on (never throws)', async () => {
    await expect(portIsListening('127.0.0.1', 1, 300)).resolves.toBe(false)
  })
})

describe('resolveSystemProxy', () => {
  const table: Record<string, Record<string, string>> = {
    'org.gnome.system.proxy': { mode: "'manual'" },
    'org.gnome.system.proxy.https': { host: "'127.0.0.1'", port: '10808' },
    'org.gnome.system.proxy.http': { host: "'127.0.0.1'", port: '10808' },
  }
  const run = async (schema: string, key: string): Promise<string> => {
    const row = table[schema]
    if (row === undefined || row[key] === undefined) throw new Error(`No such key “${key}”`)
    return row[key]
  }
  it('uses the https section, which has no enabled key', async () => {
    await expect(resolveSystemProxy(run, async () => true)).resolves.toEqual({ host: '127.0.0.1', port: 10808 })
  })
  it('falls back to the http section when https names no host', async () => {
    const partial = async (schema: string, key: string): Promise<string> => {
      if (schema === 'org.gnome.system.proxy.https') throw new Error('empty')
      return run(schema, key)
    }
    await expect(resolveSystemProxy(partial, async () => true)).resolves.toEqual({ host: '127.0.0.1', port: 10808 })
  })
  it('returns null when the panel is off', async () => {
    await expect(resolveSystemProxy(async (_s, key) => key === 'mode' ? "'none'" : "'127.0.0.1'", async () => true)).resolves.toBeNull()
  })
  it('returns null when the port is not listening — a dead proxy would kill every account call', async () => {
    await expect(resolveSystemProxy(run, async () => false, 0)).resolves.toBeNull()
  })
})

describe('parseProxyUrl', () => {
  it('accepts an http proxy with and without a scheme', () => {
    expect(parseProxyUrl('http://127.0.0.1:10808')).toEqual({ host: '127.0.0.1', port: 10808 })
    expect(parseProxyUrl('127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
  })
  it('rejects SOCKS (undici cannot use it) and anything unparseable', () => {
    for (const bad of ['', 'socks5://127.0.0.1:10808', 'ftp://x:21', 'not a url', 'http://:8080']) {
      expect(parseProxyUrl(bad)).toBeNull()
    }
  })
})

describe('isExplicitProxy', () => {
  it('treats every mode word as a mode, and anything else as a URL', () => {
    for (const word of ['', 'auto', '0', '1', 'on', 'off', 'true', 'false', 'AUTO']) {
      expect(isExplicitProxy(word)).toBe(false)
    }
    expect(isExplicitProxy('http://127.0.0.1:10808')).toBe(true)
  })
})

const yes = async () => true
const no = async () => false

describe('usableLocalProxy', () => {
  it('keeps looking when the panel proxy is listening but is SOCKS-only', async () => {
    const panel = { host: '127.0.0.1', port: 10809 }
    const found = await usableLocalProxy(panel, [10809, 10808],
      async (proxy) => proxy.port === 10808, yes)
    expect(found).toEqual({ host: '127.0.0.1', port: 10808 })
  })
  it('costs nothing when no candidate is listening', async () => {
    expect(await usableLocalProxy(null, [1, 2, 3], yes, no)).toBeNull()
  })
})

describe('proxyCanConnect against local listeners', () => {
  const serve = (reply: string) => new Promise<number>((resolve) => {
    const net = require('node:net') as typeof import('node:net')
    const server = net.createServer((socket) => socket.end(reply))
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  // Discrimination matters: a 200 answer is not proof, because xray itself replies 200 before it
  // resolves the name, and any HTTP server answers a status line. Trusting either would put the
  // host's HTTPS behind a non-proxy, which repeats the failure this probe exists to prevent.
  it('rejects a listener that claims 200 but cannot carry TLS to the origin', async () => {
    const port = await serve('HTTP/1.1 200 Connection established' + String.fromCharCode(13, 10, 13, 10))
    const started = Date.now()
    expect(await proxyCanConnect({ host: '127.0.0.1', port }, 'example.com', 800)).toBe(false)
    expect(Date.now() - started).toBeLessThan(3000)
  })
  it('rejects a listener that answers the CONNECT with an error status', async () => {
    const port = await serve('HTTP/1.1 400 Bad Request' + String.fromCharCode(13, 10, 13, 10))
    expect(await proxyCanConnect({ host: '127.0.0.1', port }, 'example.com', 1500)).toBe(false)
  })
  it('answers no instead of throwing for a port that cannot be dialed', async () => {
    expect(await proxyCanConnect({ host: '127.0.0.1', port: 70000 })).toBe(false)
    expect(await proxyCanConnect({ host: 'no-such-host.invalid', port: 10808 })).toBe(false)
  })
})

