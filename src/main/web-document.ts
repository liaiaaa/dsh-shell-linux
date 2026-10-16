/**
 * Local Web document and authenticated HTTP forwarding for the application window.
 * Adapted from deepseek-ai/deepseek-harness apps/desktop/src/web-document.ts (MIT).
 */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/**
 * Caption bar for the frameless window: a drag strip carrying the official menu row on the
 * left and the window controls on the right. Injected with the index document (the same slot
 * the boot-readiness script uses) because the shipped frontend is read-only. Styling is
 * inline so the strip paints before any app CSS loads.
 *
 * The strip is 40px and transparent. 40px is upstream's WINDOWS_TITLEBAR_HEIGHT
 * (dsh-desktop-next/src/windows-layout.ts) and transparency matches WINDOWS_CAPTION_FILL
 * ('#00000000') — the app's own background shows through, and only the foreground adapts to
 * the theme (sampled body background, luminance picks the tone). Upstream draws NO title
 * text in its caption, so neither does this one; the menu row (28px tall, radius 6px,
 * padding 0 10px, gap 2px) follows upstream preload-menu.ts, and the round buttons follow
 * the system Yaru titlebutton metrics (28px circle, 10px glyph, 2px gaps, 6px edge padding).
 *
 * The space below the strip is reserved with a body border-top only. An earlier version also
 * set `documentElement.style.paddingTop`, which double-counted the space: the app laid itself
 * out past the viewport, clipping its bottom status bar and dragging the document scrollbar
 * across the strip.
 */
const CAPTION = `
<div id="dsh-shell-linux-caption" style="position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483647;
  display:flex;align-items:center;justify-content:space-between;background:transparent;color:#cfcfcf;
  font:12px/40px system-ui,-apple-system,sans-serif;-webkit-app-region:drag;user-select:none;">
  <span id="dsh-caption-menu" style="display:flex;align-items:center;gap:2px;height:40px;padding-left:6px;
    -webkit-app-region:no-drag;">
    <button data-menu="file" style="height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;
      color:inherit;font:inherit;font-size:14px;line-height:28px;cursor:default;">文件</button>
    <button data-menu="help" style="height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;
      color:inherit;font:inherit;font-size:14px;line-height:28px;cursor:default;">帮助</button>
  </span>
  <span id="dsh-caption-controls" style="display:flex;align-items:center;gap:2px;height:40px;padding-right:6px;
    -webkit-app-region:no-drag;">
    <button data-caption="min" style="width:28px;height:28px;border:0;border-radius:50%;background:transparent;
      color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;"
      aria-label="minimize"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button>
    <button data-caption="max" style="width:28px;height:28px;border:0;border-radius:50%;background:transparent;
      color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;"
      aria-label="maximize"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.6" y="0.6" width="8.8" height="8.8" fill="none" stroke="currentColor" stroke-width="1.2" rx="1"/>
      <rect id="dsh-caption-restore-bar" x="2" y="2" width="6" height="2" fill="currentColor"
      visibility="hidden"/></svg></button>
    <button data-caption="close" style="width:28px;height:28px;border:0;border-radius:50%;background:transparent;
      color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;"
      aria-label="close"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0.7" y1="0.7" x2="9.3" y2="9.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="9.3" y1="0.7" x2="0.7" y2="9.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button>
  </span>
</div>
<script>
(function () {
  var bar = document.getElementById('dsh-shell-linux-caption');
  if (!bar) return;
  var w = window.dshDesktopWindow;
  if (w) {
    var controls = { min: w.minimize, max: w.toggleMaximize, close: w.close };
    bar.addEventListener('click', function (event) {
      var control = event.target.closest('button[data-caption]');
      if (control !== null) { controls[control.getAttribute('data-caption')](); return; }
      // Caption menus open a NATIVE popup at the clicked button's viewport coordinates.
      // A menu that cannot open must never break the window: swallow the rejection.
      var menu = event.target.closest('button[data-menu]');
      if (menu !== null && w.popupMenu) {
        var rect = menu.getBoundingClientRect();
        Promise.resolve(w.popupMenu(menu.getAttribute('data-menu'), rect.left, rect.bottom)).catch(function () {});
      }
    });
    // GNOME convention: double-click on the drag strip toggles maximize. NO button may react
    // to the double-click's click sequence — the menu buttons sit on the strip too.
    bar.addEventListener('dblclick', function (event) {
      if (event.target.closest('button') === null) w.toggleMaximize();
    });
  }
  var marker = document.createElement('style');
  // Button backgrounds live HERE, not in inline styles: an inline background:transparent
  // outranks any stylesheet :hover rule, which is why hover feedback never showed.
  marker.textContent = 'body{border-top:40px solid transparent;box-sizing:border-box;}';
  document.head.append(marker);
  var restoreBar = document.getElementById('dsh-caption-restore-bar');
  var maximized = w ? w.isMaximized() : false;
  if (w && w.onMaximizedChanged) w.onMaximizedChanged(function (state) { maximized = state; sync(); });
  function sync() {
    // The strip itself stays TRANSPARENT (upstream WINDOWS_CAPTION_FILL is '#00000000'):
    // the app's own background shows through, so the caption has no visual layer of its own.
    // Only the foreground adapts — light themes get dark glyphs, dark themes light ones.
    var bg = getComputedStyle(document.body).backgroundColor;
    var m = /rgba?\\(\\s*([0-9.]+)[,\\s]+([0-9.]+)[,\\s]+([0-9.]+)/.exec(bg);
    var dark = true;
    if (m && !/\\b0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\)/.test(bg)) {
      dark = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) < 128;
    } else {
      var htmlBg = getComputedStyle(document.documentElement).backgroundColor;
      var hm = /rgba?\\(\\s*([0-9.]+)[,\\s]+([0-9.]+)[,\\s]+([0-9.]+)/.exec(htmlBg);
      if (hm && !/\\b0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\)/.test(htmlBg)) {
        dark = (0.2126 * Number(hm[1]) + 0.7152 * Number(hm[2]) + 0.0722 * Number(hm[3])) < 128;
      } else {
        var fgSample = getComputedStyle(document.body).color;
        var fm = /rgba?\\(\\s*([0-9.]+)[,\\s]+([0-9.]+)/.exec(fgSample);
        if (fm) dark = (0.2126 * Number(fm[1]) + 0.7152 * Number(fm[2]) + 0.0722 * Number(fm[3] || 0)) >= 128;
      }
    }
    var fg = dark ? '#cfcfcf' : 'rgb(70,70,70)';
    bar.style.color = fg;
    // Hover tints and the emphasized tone follow the theme: translucent white on dark,
    // translucent black on light; the label brightens toward the primary tone on hover.
    var root = document.documentElement.style;
    root.setProperty('--dsh-caption-hover', dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)');
    root.setProperty('--dsh-caption-strong', dark ? '#ffffff' : 'rgb(30,30,30)');
    // The glyphs draw with currentColor, so one color assignment keeps every element —
    // menu labels, dashes, square, restore bar, close mark — at exactly the same tone.
    // Maximized adds a filled bar over the square (the restore glyph).
    if (restoreBar) restoreBar.setAttribute('visibility', maximized ? 'visible' : 'hidden');
  }
  // Hover feedback is JS-driven on purpose: the strip is a -webkit-app-region drag area,
  // and dragging swallows CSS :hover on the no-drag buttons underneath it (user-verified:
  // three seconds of hovering produced nothing). mouseenter/mouseleave do fire through it.
  var hoverTargets = bar.querySelectorAll('button[data-caption],button[data-menu]');
  for (var i = 0; i < hoverTargets.length; i++) {
    (function (button) {
      var isClose = button.getAttribute('data-caption') === 'close';
      button.addEventListener('mouseenter', function () {
        button.style.background = isClose ? '#e36049' : 'var(--dsh-caption-hover, rgba(255,255,255,.12))';
        if (isClose) button.style.color = '#ffffff';
        else if (button.hasAttribute('data-menu')) button.style.color = 'var(--dsh-caption-strong, #ffffff)';
      });
      button.addEventListener('mouseleave', function () {
        button.style.background = 'transparent';
        // Back to the INHERITED themed tone — never a hardcoded grey, which would leave the
        // control pale on light themes (the inline value outranks the themed bar color).
        if (isClose) button.style.color = 'inherit';
        else if (button.hasAttribute('data-menu')) button.style.color = 'inherit';
      });
    })(hoverTargets[i]);
  }
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-theme-source'] });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  new MutationObserver(sync).observe(document.head, { childList: true, subtree: true });
  sync();
})();
</script>`

export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    // EISDIR belongs with ENOENT: the frontend dist ships directories that are reachable by
    // path (`assets/`, `assets/fonts/`, `assets/langs/`), and a request for one means "no such
    // document", not a server fault. Sanctioned post-review fix (final review, Fix 1).
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? injectIndex(body.toString())
    : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Index injection: the boot-readiness script into <head>, the caption bar before </body>.
 * If the upstream frontend ever drops the </body> anchor (document shape change), the
 * caption degrades to appending at EOF — a frameless window without a caption bar has no
 * way to be dragged or closed.
 */
function injectIndex(html: string): string {
  const withBoot = html.includes('<head>')
    ? html.replace('<head>', '<head>' + BOOT)
    : html + BOOT
  return withBoot.includes('</body>')
    ? withBoot.replace('</body>', CAPTION + '</body>')
    : withBoot + CAPTION
}

export async function authenticateWebHost(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // Bounded on purpose: this is the only await between "host said ready" and "we have a window".
  // Without a deadline a wedged host leaves the app with neither a window nor an error window.
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forwarding diagnostics. Set `DSH_DESKTOP_FORWARD_LOG=1` and every forwarded request logs two
 * lines from the MAIN process: when the host returned its headers, and when its body finished
 * streaming. The stall is a WAIT (host CPU measured at 0) and the page's own resource timings
 * show nothing, so the wait lives on this path — this is the only place that can see it.
 *
 * Log lines carry parameter NAMES only, never their values: the host URL keeps its token in
 * `search`, and that must not reach the log (red line 3).
 */
/** Report a forwarded request without the switch once it is this slow (ms). */
export const SLOW_FORWARD_MS = 2000

export function forwardLogEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DSH_DESKTOP_FORWARD_LOG !== undefined && environment.DSH_DESKTOP_FORWARD_LOG !== ''
}

export function forwardLogLine(fields: {
  method: string, pathname: string, search: string, phase: 'headers' | 'body',
  ms: number, status?: number | undefined, bytes?: number | undefined
}): string {
  const names = [...new URLSearchParams(fields.search).keys()].join(',')
  const query = names === '' ? '' : '?' + names
  const status = fields.status === undefined ? '' : ' status=' + String(fields.status)
  const bytes = fields.bytes === undefined ? '' : ' bytes=' + String(fields.bytes)
  return '[forward] ' + fields.method + ' ' + fields.pathname + query + ' ' + fields.phase +
    ' ' + String(Math.round(fields.ms)) + 'ms' + status + bytes
}

export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  // Headers are always timed (a clock costs nothing) but the body is only streamed through a
  // counter when the switch is on: every measured wait landed in the headers, so wrapping the
  // 10MB plugin bundles would be pure overhead for no signal.
  const log = forwardLogEnabled()
  const started = performance.now()
  const fields = { method: request.method, pathname: source.pathname, search: source.search }
  const response = await fetch(target, init)
  const headerMs = performance.now() - started
  if (log || headerMs > SLOW_FORWARD_MS) console.error(forwardLogLine({ ...fields, phase: 'headers', ms: headerMs, status: response.status }))
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  if (!log || response.body === null) return new Response(response.body, { status: response.status, headers: outgoing })
  // A slow body is a different failure from a slow header: the host is generating or stalling
  // mid-stream, and the UI waits for the parsed payload, not for the 200.
  let bytes = 0
  const counted = response.body.pipeThrough(new TransformStream({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
      bytes += chunk.byteLength
      controller.enqueue(chunk)
    },
    flush(): void {
      console.error(forwardLogLine({ ...fields, phase: 'body', ms: performance.now() - started, bytes }))
    },
  }))
  return new Response(counted, { status: response.status, headers: outgoing })
}
