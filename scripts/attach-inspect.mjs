/**
 * Attach to an already-running Electron app over CDP and report page facts.
 *
 * Unlike verify-shell.mjs (which launches the app), this only attaches — needed
 * for packaged apps that are launched as a binary rather than as an app dir.
 *
 * Usage: node scripts/attach-inspect.mjs [--port 9411] [--shot out.png] [--eval-file f]
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const port = Number(option('--port', '9411'))
const shotPath = option('--shot', undefined)
const evalFile = option('--eval-file', undefined)
const targetMatch = option('--match', 'dsh-app')

const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
const targets = list.filter(t => t.type === 'page')
console.log(JSON.stringify({ targets: targets.map(t => ({ title: t.title, url: t.url.replace(/\?.*$/u, '') })) }))

const target = targets.find(t => t.url.includes(targetMatch)) ?? targets[0]
if (target === undefined) { console.log(JSON.stringify({ error: 'no page target' })); process.exit(1) }
console.log(JSON.stringify({ attached: target.url.replace(/\?.*$/u, '') }))

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  socket.addEventListener('open', res, { once: true })
  socket.addEventListener('error', () => rej(new Error('cdp socket error')), { once: true })
})
let next = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (waiter === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)))
  else waiter.resolve(message.result)
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = next++
  pending.set(id, { resolve: res, reject: rej })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
const expressions = evalFile === undefined ? [] : readFileSync(evalFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
for (const expression of expressions) {
  try {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) console.log(JSON.stringify({ expr: expression, ok: false, error: result.exceptionDetails.text }))
    else console.log(JSON.stringify({ expr: expression, ok: true, value: result.result?.value }))
  } catch (error) { console.log(JSON.stringify({ expr: expression, ok: false, error: String(error) })) }
}

if (shotPath !== undefined) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(shotPath), Buffer.from(shot.data, 'base64'))
  console.log(JSON.stringify({ screenshot: resolve(shotPath) }))
}
socket.close()
process.exit(0)
