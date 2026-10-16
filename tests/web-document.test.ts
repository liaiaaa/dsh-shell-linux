import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { authenticateWebHost, forwardLogEnabled, forwardLogLine, forwardWebRequest, serveWebDocument } from '../src/main/web-document.ts'

const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)) })
}

describe('authenticateWebHost', () => {
  it('exchanges the token URL for the cookie prefix', async () => {
    const server = createServer((req, res) => {
      res.writeHead(303, { 'set-cookie': 'dsh-auth-abc=secretvalue; HttpOnly; Path=/', location: './' })
      res.end()
    })
    servers.push(server)
    const port = await listen(server)
    expect(await authenticateWebHost(`http://127.0.0.1:${String(port)}/?token=t`)).toBe('dsh-auth-abc=secretvalue')
  })
  it('rejects a non-303 answer', async () => {
    const server = createServer((req, res) => { res.writeHead(500).end() })
    servers.push(server)
    const port = await listen(server)
    await expect(authenticateWebHost(`http://127.0.0.1:${String(port)}/?token=t`)).rejects.toThrow('Desktop Host authentication failed')
  })
})

describe('serveWebDocument', () => {
  it('serves index with the boot-readiness script injected and 403s traversal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-doc-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), '<html><head></head><body></body></html>')
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
    try {
      const index = await serveWebDocument(new Request('http://x/'), root)
      const body = await index.text()
      expect(body).toContain('<head><script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>')
      const asset = await serveWebDocument(new Request('http://x/assets/app.js'), root)
      expect(await asset.text()).toBe('console.log(1)')
      // NOTE: `new URL('http://x/../secret')` normalizes to `/secret`, so build the
      // traversal raw and keep it out of URL normalization.
      const traversal = await serveWebDocument(new Request('http://x/..%2fsecret'), root)
      expect(traversal.status).toBe(403)
      const missing = await serveWebDocument(new Request('http://x/nope.js'), root)
      expect(missing.status).toBe(404)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('404s a directory path instead of surfacing EISDIR as a 500', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-doc-dir-'))
    mkdirSync(join(root, 'assets', 'fonts'), { recursive: true })
    try {
      // The real frontend dist ships directories reachable at `dsh-app://app/assets/fonts`;
      // readFile on a directory reports EISDIR, which must read as "not found", not as a 500.
      const response = await serveWebDocument(new Request('http://x/assets/fonts'), root)
      expect(response.status).toBe(404)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('injects the caption bar into the index document only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-doc-caption-'))
    try {
      writeFileSync(join(root, 'index.html'), '<html><head></head><body></body></html>')
      const body = await (await serveWebDocument(new Request('http://x/'), root)).text()
      // The frameless window's caption bar must be present...
      expect(body).toContain('id="dsh-shell-linux-caption"')
      // ...wired to the preload bridge, and no other document gets it.
      expect(body).toContain('dshDesktopWindow')
      // The caption carries NO title text: upstream's caption (the Windows 40px menu row)
      // draws none, and the harness UI already shows the session title right below the strip.
      expect(body).not.toContain('>DSH<')
      expect(body).not.toContain('dsh-shell-linux-caption-title')
      const asset = await serveWebDocument(new Request('http://x/assets/app.js'), root)
      expect(await asset.text()).not.toContain('dsh-shell-linux-caption')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('injects the caption bar even when the index has no </body> to anchor on', async () => {
    // The upstream frontend could change its document shape; the injection anchors on
    // '</body>' today. A missing anchor must degrade to appending at EOF, not to a
    // frameless window without any caption bar (no way to drag or close it).
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-doc-caption3-'))
    try {
      writeFileSync(join(root, 'index.html'), '<html><head></head><body><div id="root"></div>')
      const body = await (await serveWebDocument(new Request('http://x/'), root)).text()
      expect(body).toContain('id="dsh-shell-linux-caption"')
      // The boot script anchors on <head> separately; both must survive a shape change.
      expect(body).toContain('__DSH_BOOT_READY__')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('reserves 40px of caption space via the body border only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-doc-caption2-'))
    try {
      writeFileSync(join(root, 'index.html'), '<html><head></head><body></body></html>')
      const body = await (await serveWebDocument(new Request('http://x/'), root)).text()
      // The old script set BOTH html padding-top and a body border-top: the app then laid
      // out past the viewport, clipping its bottom status bar and dragging the document
      // scrollbar across the caption bar. The body border alone reserves the space.
      expect(body).not.toContain('documentElement.style.paddingTop')
      expect(body).toContain('border-top:40px solid transparent')
      // 40px is upstream's WINDOWS_TITLEBAR_HEIGHT (windows-layout.ts), adopted verbatim.
      expect(body).toContain('height:40px')
      expect(body).toContain('font:12px/40px')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('draws the official menu row and Yaru round buttons, and follows the theme', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-doc-caption4-'))
    try {
      writeFileSync(join(root, 'index.html'), '<html><head></head><body></body></html>')
      const body = await (await serveWebDocument(new Request('http://x/'), root)).text()
      // --- Official menu row (upstream preload-menu.ts): 28px tall, radius 6px,
      // padding 0 10px, gap 2px, transparent background.
      expect(body).toContain('id="dsh-caption-menu"')
      expect(body).toContain('data-menu="file"')
      expect(body).toContain('data-menu="help"')
      expect(body).toContain('height:28px;padding:0 10px;border:0;border-radius:6px')
      expect(body).toContain('gap:2px')
      // The menu label must be centered inside its 28px box. Without an explicit
      // line-height the button inherits the bar's 40px, so the text sits low in the
      // box (measured: menuHeight 28px vs lineHeight 40px) — user-reported as
      // "not quite centered". Flex centering alone does not fix a 40px line box.
      expect(body).toContain('line-height:28px')
      // The menu buttons inherit the themed foreground; they must NOT hardcode a color.
      // 14px matches upstream preload-menu.ts (`font-size: 14px` on its menu buttons); the
      // user asked for a larger label than the initial 13px.
      expect(body).toContain('color:inherit;font:inherit;font-size:14px;line-height:28px')
      // The window controls must NOT hardcode #cfcfcf either: an inline color outranks the
      // themed `bar.style.color`, which left them pale grey on light themes (measured
      // btnColor rgb(207,207,207) while the bar was rgb(70,70,70)).
      expect(body).not.toContain('color:#cfcfcf;cursor:pointer;display:flex')
      expect(body).toContain('color:inherit;cursor:pointer;display:flex')
      // The menu buttons drive the native popup bridge, and a failure must stay silent
      // (a menu that cannot open must never break the window).
      expect(body).toContain('popupMenu')
      expect(body).toContain('.catch(')
      // --- Yaru titlebutton metrics: 28px circle, 10px glyph, 2px gaps, 6px edge padding.
      expect(body).toContain('width:28px;height:28px;border:0;border-radius:50%')
      expect(body).toContain('padding-right:6px')
      expect(body).toContain('width="10" height="10"')
      // Three same-family vector glyphs, all currentColor (the ✧/–/✕ mix is gone).
      expect(body).toContain('data-caption="min"')
      expect(body).toContain('data-caption="max"')
      expect(body).toContain('data-caption="close"')
      expect(body).toContain('dsh-caption-restore-bar')
      expect(body).toContain('currentColor')
      expect(body).not.toContain('&#x2013;')
      expect(body).not.toContain('&#x2715;')
      // --- Theme following: sample the app's own body background.
      expect(body).toContain('getComputedStyle(document.body).backgroundColor')
      expect(body).toContain('0.2126')
      expect(body).toContain('MutationObserver')
      // Hover is JS-driven on purpose: the strip is a -webkit-app-region drag area, and
      // dragging swallows CSS :hover on the buttons underneath it (user-verified).
      expect(body).toContain('--dsh-caption-hover')
      expect(body).toContain('--dsh-caption-strong')
      expect(body).toContain("addEventListener('mouseenter'")
      expect(body).toContain("addEventListener('mouseleave'")
      // Double-click on the drag strip toggles maximize; NO button may react to it —
      // the menu buttons sit on the strip too, hence the bare `button` guard.
      expect(body).toContain("addEventListener('dblclick'")
      expect(body).toContain("closest('button') === null")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('forwardWebRequest', () => {
  it('injects the cookie, strips origin/sec-fetch-site, withholds connection-level response headers, streams the body', async () => {
    let seen: Record<string, string | undefined> = {}
    const server = createServer((req, res) => {
      seen = { origin: req.headers.origin, secFetchSite: req.headers['sec-fetch-site'], cookie: req.headers.cookie }
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'host-secret=1', 'content-encoding': 'gzip' })
      // NOTE: the header must be truthful — Node's fetch decodes `content-encoding: gzip`
      // itself and throws on a plaintext body. Two gzip members keep the chunks separate.
      res.write(gzipSync(Buffer.from('chunk-one-')))
      setTimeout(() => { res.end(gzipSync(Buffer.from('chunk-two'))) }, 20)
    })
    servers.push(server)
    const port = await listen(server)
    const request = new Request(`dsh-app://app/api/remote.mux?x=1`, {
      method: 'POST', headers: { origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin' }, body: 'payload',
    })
    const response = await forwardWebRequest(request, `http://127.0.0.1:${String(port)}`, 'dsh-auth-abc=secretvalue')
    expect(seen.cookie).toBe('dsh-auth-abc=secretvalue')
    expect(seen.origin).toBeUndefined()
    expect(seen.secFetchSite).toBeUndefined()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toBe('chunk-one-chunk-two')
  })
  it('rejects foreign origins and marks plugin bundles no-store', async () => {
    const server = createServer((req, res) => { res.writeHead(200, { 'cache-control': 'immutable' }).end('bundle') })
    servers.push(server)
    const port = await listen(server)
    const foreign = await forwardWebRequest(
      new Request('dsh-app://app/api/x', { headers: { origin: 'https://evil.example' } }),
      `http://127.0.0.1:${String(port)}`, 'c=1')
    expect(foreign.status).toBe(403)
    // NOTE: `http://dsh-app/app/...` parses as pathname `/app/plugins/...`, which the
    // `/^\/plugins\//` guard never matches; the real shell passes `dsh-app://app/...`.
    const bundle = await forwardWebRequest(new Request('dsh-app://app/plugins/x/boot.js'), `http://127.0.0.1:${String(port)}`, 'c=1')
    expect(bundle.headers.get('cache-control')).toBe('no-store')
  })
})

describe('forward logging', () => {
  it('is off unless the switch is set', () => {
    expect(forwardLogEnabled({})).toBe(false)
    expect(forwardLogEnabled({ DSH_DESKTOP_FORWARD_LOG: '1' })).toBe(true)
  })
  it('logs parameter NAMES only, never a token value', () => {
    const line = forwardLogLine({
      method: 'POST', pathname: '/api/remote.mux', search: 'token=SECRETVALUE&x=1',
      phase: 'headers', ms: 1234.6, status: 200,
    })
    expect(line).toBe('[forward] POST /api/remote.mux?token,x headers 1235ms status=200')
    expect(line).not.toContain('SECRETVALUE')
  })
  it('omits the query, status and byte parts when absent', () => {
    expect(forwardLogLine({ method: 'GET', pathname: '/plugins/x', search: '', phase: 'body', ms: 7 })).toBe('[forward] GET /plugins/x body 7ms')
    expect(forwardLogLine({ method: 'GET', pathname: '/a', search: '', phase: 'body', ms: 7, bytes: 533820 })).toBe('[forward] GET /a body 7ms bytes=533820')
  })
})

describe('authenticateWebHost injectable fetch', () => {
  it('delegates to the injected fetch implementation and reads its cookie', async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-x=injected; Path=/' } })
    }) as unknown as typeof fetch
    const cookie = await authenticateWebHost('http://host/?token=t', fake)
    expect(calls).toEqual(['http://host/?token=t'])
    expect(cookie).toBe('dsh-auth-x=injected')
  })
})
