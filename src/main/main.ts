/** dsh-shell-linux entry: window + dsh-app protocol + host lifecycle. */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, session, shell } from 'electron'
import { installProcessStreamGuards } from './console-guard.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_IPC, SCHEME, type HostEvent } from '../shared/ipc.ts'
import { frontendDist, installedDshVersion } from '../shared/config.ts'
import { HostProcess, resolveHostNode } from './host-process.ts'
import { authenticateWebHost, forwardWebRequest, serveWebDocument } from './web-document.ts'
import { hostProxyEnvironment, planHostRoute } from './env.ts'
import { proxyCanConnect, resolveSystemProxy, usableLocalProxy, withSystemProxy, type SystemProxy } from './system-proxy.ts'
import { cacheUpstream, startTunnel, type Tunnel, type TunnelResult, type UpstreamProbe } from './tunnel.ts'
import { writeOverlayPatch } from '../host/overlay-patch.ts'
import { platformLoginUrl } from './platform-login.ts'
import { clampToWorkArea, isRestorableState, normalizeWindowState, type WindowState } from './window-state.ts'
import { checkForDshUpdate } from './updates.ts'
import { createShortcutsService } from './shortcuts.ts'
import { CrashBackoff } from './crash-policy.ts'
import { buildApplicationMenuTemplate, buildPopupMenuTemplate, resolvePopupRequest } from './app-menu.ts'

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
])

const here = fileURLToPath(new URL('.', import.meta.url))
// here = <project>/dist/node/main/ → three levels up is the project root.
const projectRoot = join(here, '..', '..', '..')
// Default to the current user's own profile. A hardcoded home directory would make the shell fail
// on every other machine, and `homedir()` is the portable way to name it.
const profileDir = process.env.DSH_DESKTOP_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web')
const openDevTools = process.env.DSH_DESKTOP_DEVTOOLS !== undefined
// An `error` listener on both process streams, installed before anything can write to them. Without
// it a detached stdout — screen off, lock, GNOME session restart — raises EPIPE as an uncaught
// exception and Electron shows "A JavaScript error occurred in the main process", killing the shell
// and the host child with it. Measured: try/catch and console.log do NOT prevent that; only having
// the listener does. See src/main/console-guard.ts.
installProcessStreamGuards()
// A dead proxy makes every account API fail with 'network' even on a fine direct link;
// DSH_DESKTOP_NO_PROXY=1 drops the proxy variables before the host ever sees them — and,
// because the main process's own fetch (token→cookie exchange, authenticateWebHost) is
// Node's undici reading these very variables, from this process too. Without the switch,
// a dead proxy kills the shell at startup with a bare `fetch failed`.
const noProxy = process.env.DSH_DESKTOP_NO_PROXY === '1' || process.env.DSH_DESKTOP_NO_PROXY === 'true'
if (noProxy) {
  // The main process's own fetch reads these variables when the environment asks for it
  // (Node's NODE_USE_ENV_PROXY), and so does everything DSH runs: its dsh-http-proxy layer
  // re-resolves the proxy env and re-enables the flag for the account APIs. A dead proxy
  // therefore kills the token→cookie exchange (`fetch failed`) and every account request
  // (`errorCode: 'network'`) even though the link is fine. Stripping the variables here —
  // before anything downstream reads them — makes the whole tree connect directly.
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'rsync_proxy', 'no_proxy']) {
    delete process.env[name]
    delete process.env[name.toUpperCase()]
  }
}

let mainWindow: BrowserWindow | undefined
let errorWindow: BrowserWindow | undefined
let hostProcess: HostProcess | undefined
let tunnelServer: Tunnel | undefined
let hostUrl: string | undefined
let hostCookie: string | undefined
let injections: readonly unknown[] = []
let shuttingDown = false
let fatalReported = false

/** Window geometry persistence, in the shell's own userData directory (never ~/.dsh). */
const statePath = (): string => join(app.getPath('userData'), 'window-state.json')

function loadWindowState(): WindowState {
  try {
    const raw: unknown = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (!isRestorableState(raw)) return normalizeWindowState(null)
    // A display may have changed since the last run; never restore off-screen.
    return clampToWorkArea(normalizeWindowState(raw), screen.getPrimaryDisplay().workArea)
  } catch {
    return normalizeWindowState(null)
  }
}

/** Remember geometry on close: maximized windows store the flag, not a bogus size. */
function saveWindowState(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  const maximized = mainWindow.isMaximized() || mainWindow.isFullScreen()
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
  const state: WindowState = { ...bounds, maximized }
  try {
    writeFileSync(statePath(), JSON.stringify(state), 'utf8')
  } catch { /* best effort: a full disk must not block quitting */ }
}

/**
 * Show the startup-failure window, or refresh the one already on screen.
 *
 * Idempotent on purpose: `close()` is asynchronous, so recreating the window leaves the
 * outgoing window's `closed` handler armed while a newer window is alive — that is how one
 * failure used to exit the process three times before anything rendered.
 */
function showErrorWindow(message: string, diagnostic: string): void {
  const escape = (text: string): string => text
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>dsh-shell-linux 启动失败</title></head>
<body style="font:14px/1.6 sans-serif;background:#1c1c1c;color:#eee;padding:24px">
<h2 style="color:#f66">DSH 桌面壳启动失败</h2><p>${escape(message)}</p>
<pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;max-height:60vh;overflow:auto">${escape(diagnostic)}</pre>
<p style="color:#888">关闭此窗口将退出应用。</p></body></html>`
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  if (errorWindow !== undefined && !errorWindow.isDestroyed()) {
    void errorWindow.loadURL(url)
    return
  }
  const window = new BrowserWindow({ width: 880, height: 620, title: 'dsh-shell-linux 启动失败' })
  errorWindow = window
  void window.loadURL(url)
  // Scoped to this instance: a stale window's `closed` event must never exit the process
  // out from under the window that is current now.
  window.on('closed', () => {
    if (errorWindow !== window) return
    errorWindow = undefined
    if (!shuttingDown) app.exit(1)
  })
}

/**
 * The single funnel for host failures. One failure reaches this function from several
 * places — the host's `error`/`close` handlers (via `handleHostEvent`) and `startBackend()`'s
 * rejection — so only the first report is allowed to drive the error window.
 */
function reportFatal(message: string, diagnostic: string): void {
  if (fatalReported) return
  fatalReported = true
  showErrorWindow(message, diagnostic)
}

function logUrl(url: string): string { return url.replace(/\?.*$/, '') }

function handleHostEvent(event: HostEvent): void {
  if (shuttingDown) return
  if (event.type === 'fatal') {
    reportFatal(event.message, event.diagnostic ?? hostProcess?.stderrTail() ?? '')
    return
  }
  if (event.type === 'platform-login') {
    if (event.request.action === 'open') {
      void shell.openExternal(platformLoginUrl(event.request.url, nativeTheme.shouldUseDarkColors)).catch((error: unknown) => {
        showErrorWindow('无法打开系统浏览器完成登录', String(error))
      })
    } else if (event.request.action === 'close' && event.request.focus && mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
}

/**
 * Whether the host child should follow the machine's system proxy.
 *
 * `auto` (the default) uses it only when the GNOME panel names a manual LOOPBACK proxy that is
 * actually listening — which on this machine is exactly the path the browser already takes, while
 * a raw Node dial to platform.deepseek.com intermittently goes silent for ~40 seconds and blocks
 * `session/create` behind it. `0`/`off` keeps the old raw path, `1`/`on`
 * forces the panel's proxy. `DSH_DESKTOP_NO_PROXY=1` always wins and stays direct.
 */
const proxyMode = process.env.DSH_DESKTOP_SYSTEM_PROXY ?? 'auto'

/**
 * Build the host child's environment, applying the route (see env.ts and tunnel.ts).
 *
 * The route is NOT decided here any more: this function only decides whether the child is pointed at
 * the shell's tunnel. That is the whole difference - a launch-time decision
 * committed the whole session to a single probe of a path that fails per connection, and a bounded
 * wait for a proxy that may never come blocked the window for it.
 */
async function hostEnvironment(): Promise<NodeJS.ProcessEnv> {
  const route = planHostRoute(proxyMode, noProxy)
  if (route.kind === 'direct') {
    // No interception at all: launch exactly as the shell did before the tunnel existed.
    const { env, note } = hostProxyEnvironment({ source: process.env, mode: proxyMode, noProxy, apply: withSystemProxy }, null)
    console.error('[dsh-shell-linux] route: ' + route.reason + ' (0ms)')
    if (note !== null) console.error(note)
    return env
  }
  // `explicit` is an order, not a search: when the user named one URL, nothing else is ever used.
  const probe: UpstreamProbe = route.explicit === null
    ? discoverUpstream
    : async () => (await proxyCanConnect(route.explicit!) ? route.explicit : null)
  let tunnel: Tunnel
  try {
    tunnel = await startTunnel(cacheUpstream(probe), undefined, logTunnelConnection)
  } catch (error) {
    // A tunnel that cannot listen must not take the window down. Falling back to "no proxy in the
    // environment" is the pre-tunnel behaviour: the raw path, with whatever stall it carries, working.
    console.error('[dsh-shell-linux] route: tunnel failed, direct instead: ' + String(error))
    const { env, note } = hostProxyEnvironment({ source: process.env, mode: proxyMode, noProxy, apply: withSystemProxy }, null)
    if (note !== null) console.error(note)
    return env
  }
  tunnelServer = tunnel
  const { env, note } = hostProxyEnvironment({
    source: process.env, mode: proxyMode, noProxy, apply: withSystemProxy,
    via: route.explicit === null ? 'shell tunnel, per-connection route' : 'shell tunnel, pinned proxy',
  }, { host: '127.0.0.1', port: tunnel.port })
  // The note says TUNNEL, not "system proxy": pointing the child at our own listener is a different
  // thing from following the panel, and a log line that conflated them would send the next reader
  // looking for a proxy that is not being used.
  console.error('[dsh-shell-linux] route: shell tunnel 127.0.0.1:' + String(tunnel.port) +
    (route.explicit === null ? ' (per-connection, no launch wait)' : ' (pinned to the named proxy)'))
  if (note !== null) console.error(note)
  return env
}

/**
 * Ask the machine, right now, for a proxy that can really tunnel: panel first, then listeners.
 *
 * There is deliberately no wait here. Round 37 waited a bounded time for a proxy to appear and
 * blocked the window on it; because the tunnel re-asks for every connection, a proxy that is eleven
 * seconds away is simply found by the request that comes after it, and a user who never starts one
 * pays nothing but the per-attempt timeouts inside a single request.
 *
 * `usableLocalProxy` refuses a listener that cannot CONNECT, which is the protection that matters: a SOCKS-only
 * or half-configured proxy handed to the HTTP layer kills every account API.
 */
async function discoverUpstream(): Promise<SystemProxy | null> {
  return usableLocalProxy(await resolveSystemProxy(undefined, undefined, 0))
}

/**
 * One tunnel connection, as a line of stderr, which is how the journal sees this app.
 *
 * Target host:port and outcome only. The tunnel never terminates the client's TLS, so a token cannot
 * reach this line even by accident, and the shape is fixed here so a later change has to go through
 * a deliberate edit to leak anything (red line 3).
 */
function logTunnelConnection(result: TunnelResult): void {
  const paths = result.attempts
    .map((attempt) => attempt.path + (attempt.ok ? '=ok' : '=fail(' + attempt.note + ')'))
    .join(' ')
  console.error('[dsh-shell-linux] tunnel ' + result.target + ' ' + (result.ok ? 'up' : '502') + ' ' +
    String(result.ms) + 'ms ' + paths)
}

async function startBackend(): Promise<void> {
  // Cap the account plugin's platform timeouts at 3s (see src/host/overlay-patch.ts, whose
  // header records that this does NOT fix the stall — the system-proxy follow does). The overlay
  // lives in the shell's OWN userData; ~/.dsh is never written to.
  // An explicit DSH_DESKTOP_HOST_PATCH wins (advanced users / experiments); otherwise the
  // shell writes its own default overlay into userData.
  const overlayPath = process.env.DSH_DESKTOP_HOST_PATCH ?? writeOverlayPatch(join(app.getPath('userData'), 'account-timeout-overlay.yml'))
  // D4: a standalone system Node runs the host; the Electron binary in Node mode would
  // define `process.versions.electron` and break the user's office-skills plugin.
  hostProcess = new HostProcess(resolveHostNode(), join(projectRoot, 'dist/node/host/index.js'), profileDir,
    { ...(await hostEnvironment()), DSH_DESKTOP_HOST_PATCH: overlayPath })
  hostProcess.onEvent(handleHostEvent)
  hostProcess.start()
  const ready = await new Promise<Extract<HostEvent, { type: 'ready' }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH host 未在 120 秒内就绪')), 120_000)
    timer.unref()
    const stop = hostProcess!.onEvent((event) => {
      if (event.type === 'ready') { clearTimeout(timer); stop(); resolve(event) }
      if (event.type === 'fatal') { clearTimeout(timer); stop(); reject(new Error(event.message)) }
    })
  })
  hostCookie = await authenticateWebHost(ready.url)
  hostUrl = ready.url
  injections = ready.injections ?? []
  if (openDevTools) console.log('[dsh-shell-linux] host ready:', logUrl(ready.url))
}

function createWindow(): void {
  // Frameless: GNOME's server-side title bar clashes with the app's dark UI, and the
  // in-page caption bar replaces it. Window dragging is delegated to the page through
  // `-webkit-app-region: drag` on the caption strip. Geometry comes from the last
  // session (clamped to the current work area), falling back to the defaults below.
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    width: saved.width, height: saved.height,
    minWidth: 520, minHeight: 400,
    x: saved.x, y: saved.y,
    title: 'DSH', show: false, backgroundColor: '#1c1c1c',
    autoHideMenuBar: true,
    frame: false,
    icon: join(projectRoot, 'assets/icon.png'),
    webPreferences: { preload: join(projectRoot, 'dist/preload/app.cjs') },
  })
  if (saved.maximized) mainWindow.maximize()
  // Electron's default File/Edit/View/Window menu is redundant here: the app draws its own
  // sidebar and the menu is English-only boilerplate. Hide it, but keep the application menu
  // mounted so its accelerators (Ctrl+Q, Ctrl+Shift+I, ...) still work.
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => { mainWindow?.show() })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) { void shell.openExternal(url); return { action: 'deny' } }
    return { action: 'allow' }
  })
  if (openDevTools) mainWindow.webContents.openDevTools({ mode: 'detach' })
  void mainWindow.loadURL(`${SCHEME}://app/`)
  // A renderer crash must not leave a dead white window: reload (the host and the boot
  // flow survive independently), but stop after repeated crashes inside a short window —
  // a wedged renderer would otherwise become an infinite reload loop. The history is
  // deliberately NOT reset on did-finish-load: the reload we issue after a crash also
  // fires that event, which would zero the counter and defeat the backoff.
  const crashBackoff = new CrashBackoff({ windowMs: 60_000, maxReloads: 2 })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    if (crashBackoff.registerAndDecide(Date.now())) {
      void mainWindow?.loadURL(`${SCHEME}://app/`)
    } else {
      reportFatal('渲染进程反复崩溃，已停止自动恢复', JSON.stringify(details))
    }
  })
  mainWindow.on('close', () => { saveWindowState() })
  mainWindow.on('closed', () => { mainWindow = undefined })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Two shell instances would run two hosts on one profile; refuse the second.
  app.quit()
} else {
  app.on('second-instance', () => { mainWindow?.focus() })

  app.whenReady().then(async () => {
    protocol.handle(SCHEME, (request) => {
      const url = new URL(request.url)
      if (url.hostname !== 'app') return new Response(null, { status: 404 })
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
        || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
        return serveWebDocument(request, frontendDist())
      }
      if (hostUrl === undefined || hostCookie === undefined) return new Response(null, { status: 503 })
      return forwardWebRequest(request, hostUrl, hostCookie)
    })

    ipcMain.handle(DESKTOP_IPC.boot, (event) => {
      if (mainWindow === undefined || mainWindow.isDestroyed() || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('rejected boot IPC from an unowned frame')
      }
      if (hostUrl === undefined) throw new Error('DSH host is unavailable')
      return { injections, streamBaseUrl: new URL(hostUrl).origin }
    })

    ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
      if (mainWindow === undefined || mainWindow.isDestroyed() || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('rejected boot-failure IPC from an unowned frame')
      }
      if (typeof message !== 'string') throw new Error('boot failure must be text')
      showErrorWindow(`页面启动失败：${message}`, hostProcess?.stderrTail() ?? '')
    })

    ipcMain.handle(DESKTOP_IPC.directoryPick, async (event) => {
      if (mainWindow === undefined || mainWindow.isDestroyed() || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('unowned frame')
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    })

    // Both menu dialogs anchor on the main window when it exists; showMessageBox rejects
    // if that window dies mid-await (user quits while the box is up), and a menu click
    // handler has no catcher — so the rejection must be swallowed here, explicitly.
    const showDialog = async (options: Electron.MessageBoxOptions): Promise<void> => {
      try { await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined!, options) }
      catch { /* the window went away between click and dialog; nothing left to show */ }
    }
    // Help menu: check the npm registry for a newer DSH. The shell references the system
    // install by design, so upgrading stays the user's own `npm i -g @deepseek-ai/dsh`.
    let updateCheckInFlight = false
    const checkForUpdates = async (): Promise<void> => {
      if (updateCheckInFlight) return
      updateCheckInFlight = true
      try {
        const result = await checkForDshUpdate({ localVersion: installedDshVersion() })
        if (result.status === 'ok' && result.updateAvailable) {
          await showDialog({
            type: 'info',
            title: 'DSH 更新',
            message: `发现新版本 DSH ${result.latestVersion}`,
            detail: `当前版本 ${installedDshVersion()}。壳子引用系统安装，升级后重启壳子即可生效：\n\nnpm i -g @deepseek-ai/dsh`,
            buttons: ['知道了'],
          })
        } else if (result.status === 'ok') {
          await showDialog({
            type: 'info', title: 'DSH 更新', message: '已是最新版本',
            detail: `当前版本 ${result.latestVersion}（npm registry 一致）。`, buttons: ['知道了'],
          })
        } else {
          await showDialog({
            type: 'warning', title: 'DSH 更新',
            message: result.status === 'unreachable' ? `无法访问 npm registry（${result.reason}）` : `检查失败：${result.reason}`,
            detail: '请检查网络后重试。', buttons: ['知道了'],
          })
        }
      } finally { updateCheckInFlight = false }
    }
    // About: the shell's own versions plus the system components it borrows — the DSH
    // version matters because the shell references the system install by design.
    const showAbout = async (): Promise<void> => {
      const dshVersion = (() => { try { return installedDshVersion() } catch { return '未知' } })()
      await showDialog({
        type: 'info', title: '关于 dsh-shell-linux', message: 'dsh-shell-linux 0.1.0',
        detail: [
          'Linux 桌面壳：把系统已安装的 DSH 的 Web 端（即 dsh web 的界面）装进独立窗口。',
          '',
          `DSH（系统安装）: ${dshVersion}`,
          `Electron: ${process.versions.electron ?? '未知'}`,
          `Node（主进程）: ${process.versions.node ?? '未知'}`,
          `Chrome: ${process.versions.chrome ?? '未知'}`,
          '',
          'host 子进程解释器: /usr/bin/node（DSH_DESKTOP_NODE 可覆盖）',
          '壳子不打包 DSH 运行时；系统 dsh 升级后重启壳子即生效。',
        ].join('\n'),
        buttons: ['知道了'],
      })
    }
    // The menu bar stays hidden (autoHideMenuBar + setMenuBarVisibility(false)), but its
    // accelerators keep working globally — so the two dialogs are reachable via F1 and
    // Ctrl+Shift+U even though no menu bar is ever shown. The template is shared with the
    // in-page caption popups (app-menu.ts) so labels and accelerators cannot drift.
    const menuActions = {
      checkForUpdates: (): void => { void checkForUpdates() },
      showAbout: (): void => { void showAbout() },
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(menuActions)))

    // Shortcut-preference persistence: the frontend's shortcut editor runs as desktop
    // runtime (data-platform is set) and routes reads/writes through dshDesktop.shortcuts.
    const shortcuts = createShortcutsService({
      storagePath: join(app.getPath('userData'), 'keybindings.json'),
      platform: 'linux' as const,
    })
    ipcMain.handle(DESKTOP_IPC.shortcutsGet, (_event, definitions: unknown) => {
      if (!Array.isArray(definitions)) throw new Error('shortcut catalog must be an array')
      return shortcuts.get(definitions)
    })
    ipcMain.handle(DESKTOP_IPC.shortcutsEdit, (_event, edit: unknown, revision: unknown) => {
      if (typeof revision !== 'string') throw new Error('shortcut edit revision must be a string')
      return shortcuts.edit(edit, revision)
    })
    ipcMain.on(DESKTOP_IPC.shortcutsRecording, (event, active: unknown) => {
      if (event.senderFrame !== mainWindow?.webContents.mainFrame) return
      if (typeof active === 'boolean') void shortcuts.recording(active)
    })
    const pushShortcuts = (snapshot: unknown): void => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_IPC.shortcutsChanged, snapshot)
    }
    const disposeShortcutsPush = shortcuts.subscribe(pushShortcuts)
    app.on('will-quit', () => { disposeShortcutsPush(); shortcuts.dispose() })

    // Window controls for the frameless caption bar. These mutate window state only;
    // they are safe to expose because the caption strip lives in the app's own page.
    ipcMain.on(DESKTOP_IPC.windowControl, (event, action: unknown) => {
      if (mainWindow === undefined || mainWindow.isDestroyed() || event.senderFrame !== mainWindow.webContents.mainFrame) return
      if (action === 'minimize') mainWindow.minimize()
      else if (action === 'maximize') {
        if (mainWindow.isMaximized()) mainWindow.unmaximize()
        else mainWindow.maximize()
        // The WM applies the change asynchronously; a page reading isMaximized() right
        // after the IPC may observe the stale state (probe-observed). Push on the
        // maximize/unmaximize events — they fire when the WM has actually settled.
        const push = (): void => {
          if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(DESKTOP_IPC.windowState, mainWindow.isMaximized())
          }
        }
        mainWindow.once('maximize', push)
        mainWindow.once('unmaximize', push)
      } else if (action === 'close') mainWindow.close()
      else if (action === 'maximized-state') {
        event.returnValue = mainWindow.isMaximized()
      }
    })

    // In-page caption menus. The page sends the viewport coordinates of the button that was
    // clicked; the popup itself is a native menu. `getZoomFactor` maps CSS pixels into the
    // window's device space (upstream does the same). The returned promise resolves only when
    // the popup closes, and focus returns to the page so the editor keeps receiving keys.
    ipcMain.handle(DESKTOP_IPC.menuPopup, (event, name: unknown, x: unknown, y: unknown) => {
      if (mainWindow === undefined || mainWindow.isDestroyed() || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('rejected menu popup IPC from an unowned frame')
      }
      const request = resolvePopupRequest(name, x, y)
      const window = mainWindow
      const zoom = window.webContents.getZoomFactor()
      return new Promise<void>((resolvePopup) => {
        Menu.buildFromTemplate(buildPopupMenuTemplate(request.name, menuActions)).popup({
          window,
          x: Math.round(request.x * zoom),
          y: Math.round(request.y * zoom),
          callback: () => {
            if (!window.isDestroyed()) window.webContents.focus()
            resolvePopup()
          },
        })
      })
    })

    // WebSocket handshakes bypass protocol.handle: the renderer dials the host directly
    // (streamBaseUrl), so authentication and the Host/Origin fence are satisfied here.
    // Official behavior (apps/desktop/src/main.ts:714-722): require the app origin,
    // then rewrite origin to the host's http origin, inject the shell-owned cookie,
    // and mark the request same-origin — host-side isTrustedApiRequest + browserAuth then pass.
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*', 'wss://127.0.0.1/*'] }, (details, callback) => {
      if (hostUrl === undefined || hostCookie === undefined || details.webContentsId !== mainWindow?.webContents.id) {
        callback({})
        return
      }
      const target = new URL(hostUrl)
      const requested = new URL(details.url)
      if (requested.host !== target.host || requested.protocol !== (target.protocol === 'https:' ? 'wss:' : 'ws:')) { callback({}); return }
      const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
      if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
      callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, 'sec-fetch-site': 'same-origin' } })
    })

    try {
      await startBackend()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reportFatal(message, hostProcess?.stderrTail() ?? '')
      return
    }
    createWindow()
  })

  app.on('window-all-closed', () => { app.quit() })

  app.on('before-quit', (event) => {
    // Quit paths that bypass the window's close event (SIGTERM, app.quit from the menu
    // with the window already going away) must still persist the geometry.
    saveWindowState()
    if (shuttingDown || hostProcess === undefined) return
    event.preventDefault()
    shuttingDown = true
    const stopped = hostProcess.shutdown().catch(() => undefined)
    void stopped.then(async () => {
      // The tunnel is the child's only route, so it goes after the host, and never before.
      try { await tunnelServer?.close() } catch { /* a listener that will not close dies with us */ }
      app.exit(0)
    })
  })
}
