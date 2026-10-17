import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { candidateAnchors, frontendDist, installAnchor, resolveInstallAnchor } from '../src/shared/config.ts'

const ANCHOR = '/opt/dsh/node_modules/@deepseek-ai/dsh/package.json'
const ANCHOR_DIR = '/opt/dsh/node_modules/@deepseek-ai/dsh'
const NESTED = `${ANCHOR_DIR}/node_modules/@deepseek-ai/dsh-web-frontend/dist`
const FLAT = '/opt/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'

afterEach(() => { delete process.env.DSH_INSTALL_ANCHOR })

describe('candidateAnchors', () => {
  it('offers the user prefix before the system one', () => {
    // Order matters: a plain `npm i -g` updates the user prefix, and ~/.local/bin precedes
    // /usr/local/bin on PATH, so the shell must agree with what `dsh` resolves to.
    expect(candidateAnchors('/home/someone')).toEqual([
      '/home/someone/.local/lib/node_modules/@deepseek-ai/dsh/package.json',
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    ])
  })
})

describe('resolveInstallAnchor', () => {
  const HOME = '/home/someone'
  const [USER_ANCHOR, SYSTEM_ANCHOR] = candidateAnchors(HOME)

  it('honors DSH_INSTALL_ANCHOR outright, even when it does not exist', () => {
    // The escape hatch for a layout neither candidate describes (pnpm tree, custom --prefix).
    const anchor = resolveInstallAnchor(() => false, HOME, { DSH_INSTALL_ANCHOR: ANCHOR })
    expect(anchor).toBe(ANCHOR)
  })
  it('ignores an empty override rather than resolving to the empty string', () => {
    expect(resolveInstallAnchor((p) => p === SYSTEM_ANCHOR, HOME, { DSH_INSTALL_ANCHOR: '' })).toBe(SYSTEM_ANCHOR)
  })
  it('picks the user install when it is the only one', () => {
    expect(resolveInstallAnchor((p) => p === USER_ANCHOR, HOME, {})).toBe(USER_ANCHOR)
  })
  it('picks the system install when the user prefix has no dsh', () => {
    expect(resolveInstallAnchor((p) => p === SYSTEM_ANCHOR, HOME, {})).toBe(SYSTEM_ANCHOR)
  })
  it('prefers the user install when both exist, matching PATH order', () => {
    // This is the state the development machine reached after two installs; picking the stale
    // system copy would silently run an older dsh than the one `dsh --version` reports.
    expect(resolveInstallAnchor(() => true, HOME, {})).toBe(USER_ANCHOR)
  })
  it('names a candidate when nothing is installed, so the error is actionable', () => {
    expect(resolveInstallAnchor(() => false, HOME, {})).toBe(USER_ANCHOR)
  })
})

describe('installAnchor', () => {
  it('honors DSH_INSTALL_ANCHOR when set', () => {
    process.env.DSH_INSTALL_ANCHOR = ANCHOR
    expect(installAnchor()).toBe(ANCHOR)
  })
  it('resolves to an install that exists on this machine', () => {
    expect(existsSync(installAnchor())).toBe(true)
  })
})

describe('frontendDist', () => {
  it('picks the nested layout of the older installs (and of a pnpm tree)', () => {
    process.env.DSH_INSTALL_ANCHOR = ANCHOR
    expect(frontendDist(p => p === NESTED)).toBe(NESTED)
  })
  it('picks the flat layout of 0.2.1-alpha.2 and later (npm hoisting)', () => {
    process.env.DSH_INSTALL_ANCHOR = ANCHOR
    expect(frontendDist(p => p === FLAT)).toBe(FLAT)
  })
  it('prefers the nested path when both exist (same install)', () => {
    process.env.DSH_INSTALL_ANCHOR = ANCHOR
    expect(frontendDist(() => true)).toBe(NESTED)
  })
  it('keeps returning the nested path when neither exists, so the 404 path is unchanged', () => {
    process.env.DSH_INSTALL_ANCHOR = ANCHOR
    expect(frontendDist(() => false)).toBe(NESTED)
  })
})
