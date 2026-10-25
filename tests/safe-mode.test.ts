import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearStartupFailures,
  dshHome,
  profileDirFor,
  profileNameFor,
  readStartupState,
  recordStartupAttempt,
  relaunchArguments,
  rescueSeedInvocation,
  safeModeProfileDir,
  safeModeRequested,
  seedRescueProfile,
  shouldSuggestSafeMode,
  startupStatePath,
} from '../src/main/safe-mode.ts'

class FakeStream extends EventEmitter {
  setEncoding(): void { /* real pipes are decoded to utf8; nothing to record here */ }
}

type FakeChild = EventEmitter & { stdout: FakeStream, stderr: FakeStream, killed: NodeJS.Signals[], kill(signal?: NodeJS.Signals): boolean }

function fakeSpawn(onSpawn: (child: FakeChild) => void): { impl: typeof import('node:child_process').spawn, calls: string[][] } {
  const calls: string[][] = []
  const impl = ((file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.stdout = new FakeStream()
    child.stderr = new FakeStream()
    child.killed = []
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => { child.killed.push(signal); return true }
    calls.push([file, ...args])
    onSpawn(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { impl, calls }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-shell-linux-safe-mode-'))
}

describe('profile locations', () => {
  it('uses ~/.dsh unless DSH_HOME says otherwise', () => {
    expect(dshHome({}, '/home/li')).toBe('/home/li/.dsh')
    expect(dshHome({ DSH_HOME: '/tmp/h' }, '/home/li')).toBe('/tmp/h')
    expect(dshHome({ DSH_HOME: '' }, '/home/li')).toBe('/home/li/.dsh')
  })
  it('selects web, rescue, or the explicit override', () => {
    expect(profileDirFor({}, '/home/li')).toBe('/home/li/.dsh/profiles/web')
    expect(safeModeProfileDir({}, '/home/li')).toBe('/home/li/.dsh/profiles/rescue')
    expect(profileDirFor({ DSH_HOME: '/tmp/h' }, '/home/li')).toBe('/tmp/h/profiles/web')
    expect(profileDirFor({ DSH_DESKTOP_SAFE_MODE: '1' }, '/home/li')).toBe('/home/li/.dsh/profiles/rescue')
    expect(profileDirFor({ DSH_DESKTOP_PROFILE: '/x/y' }, '/home/li')).toBe('/x/y')
  })
  it('derives the host profile name from the directory', () => {
    expect(profileNameFor({}, '/home/li')).toBe('web')
    expect(profileNameFor({ DSH_DESKTOP_SAFE_MODE: '1' }, '/home/li')).toBe('rescue')
    expect(profileNameFor({ DSH_DESKTOP_PROFILE: '/x/custom/' }, '/home/li')).toBe('custom')
  })
  it('only treats DSH_DESKTOP_SAFE_MODE=1 as safe mode', () => {
    expect(safeModeRequested({ DSH_DESKTOP_SAFE_MODE: '1' }, [])).toBe(true)
    expect(safeModeRequested({ DSH_DESKTOP_SAFE_MODE: 'true' }, [])).toBe(false)
    expect(safeModeRequested({}, [])).toBe(false)
  })
  it('accepts the relaunch carrier as well', () => {
    expect(safeModeRequested({}, ['.', '--no-sandbox', '--safe-mode'])).toBe(true)
    expect(safeModeRequested({}, ['.', '--no-sandbox'])).toBe(false)
  })
})

describe('relaunchArguments', () => {
  it('adds the switch for a safe relaunch', () => {
    expect(relaunchArguments(['.', '--no-sandbox'], 'safe')).toEqual(['.', '--no-sandbox', '--safe-mode'])
  })
  it('drops it for a normal relaunch, keeping the other arguments', () => {
    expect(relaunchArguments(['.', '--no-sandbox', '--safe-mode'], 'normal')).toEqual(['.', '--no-sandbox'])
  })
  it('is idempotent when the switch is already present', () => {
    expect(relaunchArguments(['.', '--safe-mode'], 'safe')).toEqual(['.', '--safe-mode'])
  })
})

describe('startup failure counter', () => {
  it('starts fresh, counts attempts, and clears on a ready boot', () => {
    const userData = tempDir()
    expect(readStartupState(userData)).toEqual({ failures: 0 })
    expect(recordStartupAttempt(userData)).toEqual({ failures: 1 })
    expect(readStartupState(userData)).toEqual({ failures: 1 })
    expect(recordStartupAttempt(userData)).toEqual({ failures: 2 })
    clearStartupFailures(userData)
    expect(readStartupState(userData)).toEqual({ failures: 0 })
  })
  it('treats unreadable state as fresh', () => {
    const userData = tempDir()
    mkdirSync(userData, { recursive: true })
    writeFileSync(startupStatePath(userData), 'not json', 'utf8')
    expect(readStartupState(userData)).toEqual({ failures: 0 })
  })
  it('caps the recorded count', () => {
    const userData = tempDir()
    writeFileSync(startupStatePath(userData), JSON.stringify({ failures: 9 }), 'utf8')
    expect(recordStartupAttempt(userData)).toEqual({ failures: 9 })
  })
  it('offers safe mode after two consecutive failures', () => {
    expect(shouldSuggestSafeMode(0)).toBe(false)
    expect(shouldSuggestSafeMode(1)).toBe(false)
    expect(shouldSuggestSafeMode(2)).toBe(true)
  })
})

describe('rescueSeedInvocation', () => {
  it('seeds the rescue profile from the shipped web template and exits via --dump-config', () => {
    const invocation = rescueSeedInvocation('/home/li/.local/lib/node_modules/@deepseek-ai/dsh/package.json')
    expect(invocation.file).toBe('/home/li/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(invocation.args).toEqual(['--profile', 'rescue', '--from-default-profile', 'web', '--dump-config'])
  })
})

describe('seedRescueProfile', () => {
  const anchor = '/home/li/.local/lib/node_modules/@deepseek-ai/dsh/package.json'

  it('skips when the rescue profile already exists', async () => {
    const home = tempDir()
    mkdirSync(join(home, 'profiles', 'rescue'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'rescue', 'package.json'), '{}', 'utf8')
    let spawned = false
    const { impl } = fakeSpawn(() => { spawned = true })
    const result = await seedRescueProfile({ dshHome: home, node: '/usr/bin/node', anchor, environment: {}, spawnImpl: impl })
    expect(result.status).toBe('skipped')
    expect(spawned).toBe(false)
  })

  it('is ok when the CLI creates the profile and exits 0', async () => {
    const home = tempDir()
    const { impl, calls } = fakeSpawn((child) => {
      mkdirSync(join(home, 'profiles', 'rescue'), { recursive: true })
      writeFileSync(join(home, 'profiles', 'rescue', 'package.json'), '{}', 'utf8')
      setImmediate(() => { child.emit('close', 0, null) })
    })
    const result = await seedRescueProfile({ dshHome: home, node: '/usr/bin/node', anchor, environment: {}, spawnImpl: impl })
    expect(result.status).toBe('ok')
    // node runs the installed CLI entry; the profile arguments do the seeding.
    expect(calls[0]).toEqual([
      '/usr/bin/node',
      '/home/li/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '--profile', 'rescue', '--from-default-profile', 'web', '--dump-config',
    ])
  })

  it('is failed with the CLI output tail on a non-zero exit', async () => {
    const home = tempDir()
    const { impl } = fakeSpawn((child) => {
      setImmediate(() => {
        child.stderr.emit('data', 'Error: template web not found\n')
        child.emit('close', 1, null)
      })
    })
    const result = await seedRescueProfile({ dshHome: home, node: '/usr/bin/node', anchor, environment: {}, spawnImpl: impl })
    expect(result.status).toBe('failed')
    expect(result.tail).toContain('template web not found')
  })

  it('is failed when the CLI exits 0 without creating the profile', async () => {
    const home = tempDir()
    const { impl } = fakeSpawn((child) => { setImmediate(() => { child.emit('close', 0, null) }) })
    const result = await seedRescueProfile({ dshHome: home, node: '/usr/bin/node', anchor, environment: {}, spawnImpl: impl })
    expect(result.status).toBe('failed')
    expect(result.tail).toContain('没有生成')
  })

  it('is failed when the CLI cannot be spawned', async () => {
    const home = tempDir()
    const { impl } = fakeSpawn((child) => { setImmediate(() => { child.emit('error', new Error('spawn ENOENT')) }) })
    const result = await seedRescueProfile({ dshHome: home, node: '/usr/bin/node', anchor, environment: {}, spawnImpl: impl })
    expect(result.status).toBe('failed')
    expect(result.tail).toBe('spawn ENOENT')
  })
})
