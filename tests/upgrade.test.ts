import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  MAX_UPGRADE_LOG_LINES,
  canUpgradeInPlace,
  npmPrefixFromAnchor,
  runUpgrade,
  upgradeInvocation,
} from '../src/main/upgrade.ts'

class FakeStream extends EventEmitter {
  setEncoding(): void { /* the real pipe is asked for utf8; nothing to record */ }
}

type FakeChild = EventEmitter & {
  stdout: FakeStream
  stderr: FakeStream
  killed: NodeJS.Signals[]
  kill(signal?: NodeJS.Signals): boolean
}

/** A spawn stand-in that hands the fake child to the test, which drives the events. */
function fakeSpawn(onSpawn: (child: FakeChild) => void): { impl: typeof import('node:child_process').spawn, calls: { file: string, args: string[] }[] } {
  const calls: { file: string, args: string[] }[] = []
  const impl = ((file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.stdout = new FakeStream()
    child.stderr = new FakeStream()
    child.killed = []
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => { child.killed.push(signal); return true }
    calls.push({ file, args })
    onSpawn(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { impl, calls }
}

describe('npmPrefixFromAnchor', () => {
  it('walks up four levels from the installed package.json', () => {
    expect(npmPrefixFromAnchor('/home/li/.local/lib/node_modules/@deepseek-ai/dsh/package.json')).toBe('/home/li/.local')
    expect(npmPrefixFromAnchor('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')).toBe('/usr/local')
  })
})

describe('canUpgradeInPlace', () => {
  it('accepts a prefix and lib/node_modules that are writable', () => {
    const writable = new Set(['/home/li/.local', '/home/li/.local/lib/node_modules'])
    expect(canUpgradeInPlace('/home/li/.local', (path) => { if (!writable.has(path)) throw new Error('EACCES') })).toBe(true)
  })
  it('rejects a root-owned prefix', () => {
    expect(canUpgradeInPlace('/usr/local', () => { throw new Error('EACCES') })).toBe(false)
  })
  it('rejects a prefix whose lib/node_modules is missing', () => {
    expect(canUpgradeInPlace('/x', (path) => { if (path !== '/x') throw new Error('ENOENT') })).toBe(false)
  })
})

describe('upgradeInvocation', () => {
  it('installs the chosen dist-tag globally with the given npm', () => {
    const invocation = upgradeInvocation('next', '/usr/bin/npm')
    expect(invocation.file).toBe('/usr/bin/npm')
    expect(invocation.args).toEqual(['install', '-g', '@deepseek-ai/dsh@next'])
    expect(invocation.display).toBe('npm i -g @deepseek-ai/dsh@next')
  })
  it('installs the latest tag for stable installs', () => {
    expect(upgradeInvocation('latest', 'npm').args).toEqual(['install', '-g', '@deepseek-ai/dsh@latest'])
  })
})

describe('runUpgrade', () => {
  it('dry run reports the command and spawns nothing', async () => {
    const seen: string[] = []
    const result = await runUpgrade({
      tag: 'latest',
      environment: { DSH_DESKTOP_UPGRADE_DRY_RUN: '1' },
      onLine: (line) => { seen.push(line) },
    })
    expect(result.status).toBe('dry-run')
    if (result.status !== 'dry-run') throw new Error('unreachable')
    expect(result.command).toBe('npm i -g @deepseek-ai/dsh@latest')
    expect(seen[0]).toContain('演练模式')
  })
  it('streams masked stdout and stderr lines, then resolves ok on exit 0', async () => {
    const seen: string[] = []
    const { impl, calls } = fakeSpawn((child) => {
      setImmediate(() => {
        child.stdout.emit('data', 'added 1 package\n?token=secret\n')
        child.stderr.emit('data', 'warn split')
        child.stderr.emit('data', ' across chunks\n')
        child.emit('close', 0, null)
      })
    })
    const result = await runUpgrade({
      tag: 'next',
      environment: { DSH_DESKTOP_NPM: '/usr/bin/npm' },
      spawnImpl: impl,
      onLine: (line) => { seen.push(line) },
      timeoutMs: 5_000,
    })
    expect(calls).toEqual([{ file: '/usr/bin/npm', args: ['install', '-g', '@deepseek-ai/dsh@next'] }])
    expect(seen).toContain('added 1 package')
    expect(seen.join('\n')).toContain('token=<redacted>')
    expect(seen.join('\n')).toContain('warn split across chunks')
    expect(result.status).toBe('ok')
  })
  it('reports a non-zero exit as a failure with the log tail', async () => {
    const { impl } = fakeSpawn((child) => {
      setImmediate(() => {
        child.stderr.emit('data', 'npm ERR! network\n')
        child.emit('close', 7, null)
      })
    })
    const result = await runUpgrade({ tag: 'latest', spawnImpl: impl, timeoutMs: 5_000 })
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('unreachable')
    expect(result.reason).toBe('npm 退出码 7')
    expect(result.log.join('\n')).toContain('npm ERR! network')
  })
  it('reports a spawn error as a failure', async () => {
    const { impl } = fakeSpawn((child) => {
      setImmediate(() => { child.emit('error', new Error('spawn npm ENOENT')) })
    })
    const result = await runUpgrade({ tag: 'latest', spawnImpl: impl, timeoutMs: 5_000 })
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('unreachable')
    expect(result.reason).toBe('spawn npm ENOENT')
  })
  it('kills a child that never finishes and reports the timeout', async () => {
    const { impl } = fakeSpawn(() => { /* never closes */ })
    const result = await runUpgrade({ tag: 'latest', spawnImpl: impl, timeoutMs: 20 })
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('unreachable')
    expect(result.reason).toContain('没有结束')
  })
  it('keeps at most MAX_UPGRADE_LOG_LINES lines', async () => {
    const { impl } = fakeSpawn((child) => {
      setImmediate(() => {
        child.stdout.emit('data', Array.from({ length: 300 }, (_, index) => `line ${String(index)}`).join('\n') + '\n')
        child.emit('close', 0, null)
      })
    })
    const result = await runUpgrade({ tag: 'latest', spawnImpl: impl, timeoutMs: 5_000 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.log).toHaveLength(MAX_UPGRADE_LOG_LINES)
    expect(result.log.at(-1)).toBe('line 299')
  })
})
