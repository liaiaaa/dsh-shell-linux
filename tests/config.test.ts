import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_INSTALL_ANCHOR, frontendDist, installAnchor } from '../src/shared/config.ts'

const ANCHOR = '/opt/dsh/node_modules/@deepseek-ai/dsh/package.json'
const ANCHOR_DIR = '/opt/dsh/node_modules/@deepseek-ai/dsh'
const NESTED = `${ANCHOR_DIR}/node_modules/@deepseek-ai/dsh-web-frontend/dist`
const FLAT = '/opt/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'

afterEach(() => { delete process.env.DSH_INSTALL_ANCHOR })

describe('installAnchor', () => {
  it('falls back to the system install', () => {
    expect(installAnchor()).toBe(DEFAULT_INSTALL_ANCHOR)
  })
  it('honors DSH_INSTALL_ANCHOR when set', () => {
    process.env.DSH_INSTALL_ANCHOR = ANCHOR
    expect(installAnchor()).toBe(ANCHOR)
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
