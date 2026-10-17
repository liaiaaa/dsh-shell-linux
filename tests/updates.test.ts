import { describe, expect, it } from 'vitest'
import { isNewerVersion, checkForDshUpdate, distTagForVersion, upgradeCommandForTag } from '../src/main/updates.ts'

describe('isNewerVersion', () => {
  it('orders plain releases', () => {
    expect(isNewerVersion('0.3.0', '0.2.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
  })
  it('a prerelease is older than its final release', () => {
    expect(isNewerVersion('0.3.0', '0.3.0-rc.2')).toBe(true)
    expect(isNewerVersion('0.3.0-rc.2', '0.3.0-rc.1')).toBe(true)
    expect(isNewerVersion('0.3.0-rc.2', '0.3.0')).toBe(false)
  })
  it('prerelease identifiers compare numerically and lexically', () => {
    expect(isNewerVersion('0.3.0-rc.10', '0.3.0-rc.9')).toBe(true)
    expect(isNewerVersion('0.3.0-beta', '0.3.0-alpha')).toBe(true)
    expect(isNewerVersion('0.3.0-rc.1', '0.3.0-rc.1')).toBe(false)
  })
})

describe('checkForDshUpdate', () => {
  it('reports no update when registry equals local', async () => {
    const result = await checkForDshUpdate({
      localVersion: '0.2.0-rc.2',
      fetchImpl: async () => new Response(JSON.stringify({ version: '0.2.0-rc.2' }), { status: 200 }),
    })
    expect(result).toEqual({ status: 'ok', latestVersion: '0.2.0-rc.2', updateAvailable: false, channel: 'next' })
  })
  it('reports an update when registry is newer (prerelease aware)', async () => {
    const result = await checkForDshUpdate({
      localVersion: '0.2.0-rc.2',
      fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.0' }), { status: 200 }),
    })
    expect(result).toEqual({ status: 'ok', latestVersion: '0.3.0', updateAvailable: true, channel: 'next' })
  })
  it('never reports a downgrade as an update', async () => {
    const result = await checkForDshUpdate({
      localVersion: '1.0.0',
      fetchImpl: async () => new Response(JSON.stringify({ version: '0.9.0' }), { status: 200 }),
    })
    expect(result).toEqual({ status: 'ok', latestVersion: '0.9.0', updateAvailable: false, channel: 'latest' })
  })
  it('maps registry failures to unreachable with the cause code', async () => {
    const result = await checkForDshUpdate({
      localVersion: '0.2.0-rc.2',
      fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) },
    })
    expect(result).toEqual({ status: 'unreachable', reason: 'ECONNREFUSED' })
  })
  it('maps malformed registry answers to an error, not a crash', async () => {
    const result = await checkForDshUpdate({
      localVersion: '0.2.0-rc.2',
      fetchImpl: async () => new Response('not json', { status: 200 }),
    })
    expect(result.status).toBe('error')
    const result2 = await checkForDshUpdate({
      localVersion: '0.2.0-rc.2',
      fetchImpl: async () => new Response(JSON.stringify({ version: 42 }), { status: 200 }),
    })
    expect(result2.status).toBe('error')
  })
})

describe('installedDshVersion', () => {
  it('reads the version from the install anchor package.json', async () => {
    const { installedDshVersion } = await import('../src/shared/config.ts')
    const version = installedDshVersion()
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
  it('honors DSH_INSTALL_ANCHOR and rejects a file without a version', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-anchor-'))
    try {
      const anchor = join(root, 'package.json')
      writeFileSync(anchor, '{"name":"x"}')
      process.env.DSH_INSTALL_ANCHOR = anchor
      const { installedDshVersion } = await import('../src/shared/config.ts')
      expect(() => installedDshVersion()).toThrow('no version string')
    } finally {
      delete process.env.DSH_INSTALL_ANCHOR
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('distTagForVersion', () => {
  it('a prerelease install follows the prerelease tag', () => {
    // The real case this exists for: on 2026-10-17 npm `latest` still pointed at 0.2.0-rc.2
    // while `next` had moved on, so an rc install was told "up to date" forever.
    expect(distTagForVersion('0.2.0-rc.2')).toBe('next')
    expect(distTagForVersion('1.0.0-beta.1')).toBe('next')
    expect(distTagForVersion('0.3.0-alpha')).toBe('next')
  })
  it('a final release follows latest, the tag it actually came from', () => {
    expect(distTagForVersion('1.0.0')).toBe('latest')
    expect(distTagForVersion('0.2.0')).toBe('latest')
  })
})

describe('upgradeCommandForTag', () => {
  it('names the tag, because a bare install lands on latest and would undo the choice', () => {
    expect(upgradeCommandForTag('next')).toBe('npm i -g @deepseek-ai/dsh@next')
    expect(upgradeCommandForTag('latest')).toBe('npm i -g @deepseek-ai/dsh@latest')
  })
})

describe('the channel the result carries', () => {
  const ok = (version: string) => async () => new Response(JSON.stringify({ version }), { status: 200 })
  it('defaults to the tag implied by the installed version', async () => {
    const rc = await checkForDshUpdate({ localVersion: '0.2.0-rc.2', fetchImpl: ok('0.2.1-rc.1') })
    expect(rc).toMatchObject({ status: 'ok', channel: 'next', updateAvailable: true })
    const stable = await checkForDshUpdate({ localVersion: '1.0.0', fetchImpl: ok('1.0.1') })
    expect(stable).toMatchObject({ status: 'ok', channel: 'latest', updateAvailable: true })
  })
  it('queries that channel\'s endpoint, not a hardcoded latest', async () => {
    let asked = ''
    await checkForDshUpdate({
      localVersion: '0.2.0-rc.2',
      fetchImpl: async (input) => { asked = String(input); return new Response('{}', { status: 200 }) },
    })
    expect(asked).toBe('https://registry.npmjs.org/@deepseek-ai%2Fdsh/next')
  })
  it('lets a caller pin the channel explicitly', async () => {
    const pinned = await checkForDshUpdate({ localVersion: '0.2.0-rc.2', channel: 'latest', fetchImpl: ok('0.2.0-rc.2') })
    expect(pinned).toMatchObject({ status: 'ok', channel: 'latest', updateAvailable: false })
  })
})
