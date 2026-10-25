/**
 * Verification harness for the desktop shell.
 *
 * Launches the real shell (`electron .`), then attaches to it over the Chrome
 * DevTools Protocol so a headless session can verify what the window actually
 * rendered — DOM facts and a real screenshot — without any test-only code in
 * `src/main`. Electron is started with `--remote-debugging-port`, which is a
 * stock Electron/Chromium flag; production code stays untouched.
 *
 * Usage:
 *   node scripts/verify-shell.mjs <expressions.json|-> [options]
 *
 * Options:
 *   --app <dir>         app directory to launch (default: the project root)
 *   --shot <path>       capture a PNG screenshot of the page
 *   --timeout <ms>      how long to wait for the page target (default 120000)
 *   --settle <ms>       extra wait after load before evaluating (default 3000)
 *   --eval-file <path>  file of JS expressions, one per line (JSON array also OK)
 *
 * Prints one JSON object per line: {"expr":..., "ok":..., "value":...} and a
 * final {"screenshot":...} / {"error":...} line. Token-bearing URLs are never
 * printed; the caller decides what to log.
 */
import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const specArg = args[0]
if (specArg === undefined || specArg.startsWith('--')) {
  console.error('usage: verify-shell.mjs <expressions.json|-> [--shot png] [--timeout ms] [--settle ms] [--eval-file path] [--reconnect]')
  process.exit(2)
}
const shotPath = option('--shot', undefined)
const timeoutMs = Number(option('--timeout', '120000'))
const settleMs = Number(option('--settle', '3000'))
const evalFile = option('--eval-file', undefined)
const debugPort = Number(option('--port', '9333'))
const appDir = resolve(option('--app', '.'))
/** The application's custom scheme; matches SCHEME in src/shared/ipc.ts. */
const APP_SCHEME = 'dsh-app'
/**
 * Attach to the page target whose URL starts with this prefix instead of the app page.
 *
 * The About window is a `data:text/html,…` target; `--target-url data:text/html` is how the
 * harness reaches it without synthesizing F1 (only the window manager can do that reliably).
 */
const targetUrlPrefix = option('--target-url', undefined)
/** Write the shell's own stdout/stderr to this file before exiting (diagnostics for failures). */
const keepLog = option('--keep-log', undefined)
/** Per-evaluate ceiling: an awaited expression that never settles must not hang the harness. */
const EVAL_TIMEOUT_MS = Number(option('--eval-timeout', '30000'))

let expressions = []
if (evalFile !== undefined) {
  expressions = readFileSync(evalFile, 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
} else if (specArg !== '-') {
  const parsed = JSON.parse(readFileSync(specArg, 'utf8'))
  expressions = Array.isArray(parsed) ? parsed : parsed.expressions
}

const shell = spawn(resolve('node_modules/electron/dist/electron'), [appDir, '--no-sandbox', `--remote-debugging-port=${String(debugPort)}`], {
  cwd: appDir,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let shellOut = ''
shell.stdout.setEncoding('utf8')
shell.stderr.setEncoding('utf8')
shell.stdout.on('data', (chunk) => { shellOut += chunk })
shell.stderr.on('data', (chunk) => { shellOut += chunk })

const finish = (code) => {
  if (keepLog !== undefined) {
    try { writeFileSync(keepLog, shellOut) } catch { /* diagnostics are best effort */ }
  }
  try { shell.kill('SIGTERM') } catch { /* already gone */ }
  setTimeout(() => {
    try { shell.kill('SIGKILL') } catch { /* gone */ }
    // SIGTERM to the main process does not guarantee the GPU/renderer helpers die with
    // it; orphaned electron children held the single-instance lock and broke the next
    // probe (observed repeatedly). Sweep only our own child tree before exiting.
    try {
      const all = execSync('ps -eo pid,ppid,args').toString().trim().split('\n')
        .map(line => { const m = line.trim().split(/\s+/); return { pid: Number(m[0]), ppid: Number(m[1]), args: m.slice(2).join(' ') } })
      const ours = all.filter(p => p.args.includes('node_modules/electron/dist/electron')
        && (p.ppid === shell.pid || all.some(q => q.pid === p.ppid && (q.ppid === shell.pid || q.pid === shell.pid))))
      for (const p of ours) { try { process.kill(p.pid, 'SIGKILL') } catch { /* already gone */ } }
      if (ours.length > 0) console.log(JSON.stringify({ sweptOrphans: ours.map(p => p.pid) }))
    } catch { /* ps unavailable: nothing to sweep */ }
    process.exit(code)
  }, 2500)
}

async function findPageTarget() {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(debugPort)}/json/list`)
      const targets = await response.json()
      // Prefer the application page. With DSH_DESKTOP_DEVTOOLS set, the DevTools
      // window is also a "page" target and is listed first; evaluating an awaited
      // expression there never settles.
      const pages = targets.filter(target => target.type === 'page'
        && typeof target.webSocketDebuggerUrl === 'string' && !target.url.startsWith('devtools://'))
      const page = targetUrlPrefix !== undefined
        ? pages.find(target => target.url.startsWith(targetUrlPrefix))
        : (pages.find(target => target.url.startsWith(`${APP_SCHEME}://`)) ?? pages[0])
      if (page !== undefined) return page
    } catch { /* not listening yet */ }
    if (shell.exitCode !== null) throw new Error(`shell exited early with ${String(shell.exitCode)}`)
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error('timed out waiting for a page target')
}

/** Minimal CDP client over the built-in WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    })
  }
  send(method, params = {}, timeout = EVAL_TIMEOUT_MS) {
    const id = this.next++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} did not answer within ${String(timeout)}ms`))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
}

/** One attach cycle: find the app page, connect, Runtime.enable. */
async function attach() {
  const target = await findPageTarget()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
  })
  const cdp = new Cdp(socket)
  await cdp.send('Runtime.enable')
  return { socket, cdp }
}

try {
  const reconnect = args.includes('--reconnect')
  let { socket, cdp } = await attach()
  if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs))

  for (const expression of expressions) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
      })
      if (result.exceptionDetails !== undefined) {
        console.log(JSON.stringify({ expr: expression, ok: false, error: result.exceptionDetails.text ?? 'exception', description: result.exceptionDetails.exception?.description }))
      } else {
        console.log(JSON.stringify({ expr: expression, ok: true, value: result.result?.value }))
      }
    } catch (error) {
      // A dead session (crashed renderer, navigation, frozen context) is recoverable:
      // re-find the target and reconnect once, then let the expression fail for real
      // if the page is genuinely gone.
      if (reconnect) {
        try { socket.close() } catch { /* already dead */ }
        try {
          ;({ socket, cdp } = await attach())
          const result = await cdp.send('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
          })
          const value = result.exceptionDetails !== undefined ? undefined : result.result?.value
          console.log(JSON.stringify({ expr: expression, ok: result.exceptionDetails === undefined, value, error: result.exceptionDetails?.text, reconnected: true }))
          continue
        } catch (retryError) {
          console.log(JSON.stringify({ expr: expression, ok: false, error: String(retryError), reconnected: true }))
          continue
        }
      }
      console.log(JSON.stringify({ expr: expression, ok: false, error: String(error) }))
    }
  }

  if (shotPath !== undefined) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(JSON.stringify({ screenshot: resolve(shotPath) }))
  }
  socket.close()
  finish(0)
} catch (error) {
  console.log(JSON.stringify({ error: String(error), shellOutputTail: shellOut.slice(-2000).replace(/token=[^\s&"']+/gu, 'token=<redacted>') }))
  finish(1)
}
