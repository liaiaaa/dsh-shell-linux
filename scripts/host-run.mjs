/** Debug runner: start the host child from plain node with an IPC channel and forward its events. */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// The current user's own profile by default; pass a path to run against another one.
const profileDir = resolve(process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'web'))
const child = spawn(process.execPath, ['--expose-internals', resolve('dist/node/host/index.js'), profileDir], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env: process.env,
})
child.on('message', (message) => { console.log('[host-event]', JSON.stringify(message)) })
child.on('error', (error) => { console.error('[host-run] spawn error:', error); process.exitCode = 1 })
// Report on 'exit', not 'close': in the SIGTERM path the runner disconnects the IPC
// channel before killing the child, and node never fires 'close' after that, so a
// close-based report loses both the final log line and the child's exit code.
child.on('exit', (code, signal) => {
  console.log('[host-run] exited', code ?? `by ${signal ?? 'unknown'}`)
  process.exitCode = code ?? 1
})
process.on('SIGTERM', () => { child.disconnect(); child.kill('SIGTERM') })
process.on('SIGINT', () => { child.disconnect(); child.kill('SIGTERM') })
