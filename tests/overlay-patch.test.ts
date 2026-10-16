import { describe, expect, it } from 'vitest'
import { parse } from 'node:path'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCOUNT_ENTRY_ID, ACCOUNT_TIMEOUT_MS, overlayPatchYaml, writeOverlayPatch } from '../src/host/overlay-patch.ts'

describe('overlayPatchYaml', () => {
  it('targets the account entry by id', () => {
    expect(overlayPatchYaml()).toContain(`- id: ${ACCOUNT_ENTRY_ID}`)
  })
  it('caps both platform request timeouts', () => {
    const yaml = overlayPatchYaml()
    expect(yaml).toContain('requestTimeoutMs: 3000')
    expect(yaml).toContain('balanceTimeoutMs: 3000')
  })
  it('honours a custom ceiling', () => {
    const yaml = overlayPatchYaml(1500)
    expect(yaml).toContain('requestTimeoutMs: 1500')
    expect(yaml).toContain('balanceTimeoutMs: 1500')
  })
  it('is a single-entry YAML list (a patch list, not a bare map)', () => {
    const lines = overlayPatchYaml().split('\n').filter(l => l.trim() !== '' && !l.trimStart().startsWith('#'))
    expect(lines[0]).toBe(`- id: ${ACCOUNT_ENTRY_ID}`)
  })
})

describe('writeOverlayPatch', () => {
  it('writes the yaml to the given path, creating directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-overlay-'))
    const target = join(dir, 'nested', 'account-timeout-overlay.yml')
    const returned = writeOverlayPatch(target)
    expect(returned).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(overlayPatchYaml())
    expect(parse(target).ext).toBe('.yml')
  })
  it('defaults the ceiling to the exported constant', () => {
    expect(ACCOUNT_TIMEOUT_MS).toBe(3000)
    expect(overlayPatchYaml()).toContain(`requestTimeoutMs: ${String(ACCOUNT_TIMEOUT_MS)}`)
  })
})
