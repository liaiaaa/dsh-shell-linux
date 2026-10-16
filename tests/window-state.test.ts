import { describe, expect, it } from 'vitest'
import { clampToWorkArea, isRestorableState, normalizeWindowState, type WindowState } from '../src/main/window-state.ts'

describe('normalizeWindowState', () => {
  it('keeps a sane geometry and the maximized flag', () => {
    const state = normalizeWindowState({ width: 1280, height: 820, x: 100, y: 50, maximized: true })
    expect(state).toEqual({ width: 1280, height: 820, x: 100, y: 50, maximized: true })
  })
  it('rounds fractional values and drops non-finite numbers', () => {
    expect(normalizeWindowState({ width: 1280.7, height: 819.2, x: Number.NaN, y: Infinity, maximized: false }))
      .toEqual({ width: 1281, height: 819, maximized: false })
  })
  it('enforces the minimum size floor', () => {
    expect(normalizeWindowState({ width: 100, height: 10, maximized: false }).width).toBeGreaterThanOrEqual(520)
    expect(normalizeWindowState({ width: 100, height: 10, maximized: false }).height).toBeGreaterThanOrEqual(400)
  })
})

describe('clampToWorkArea', () => {
  const workArea = { x: 0, y: 27, width: 2560, height: 1413 }
  it('keeps a window fully inside the work area', () => {
    const state = clampToWorkArea({ width: 1280, height: 820, x: 1200, y: 600, maximized: false }, workArea)
    expect(state.x! + state.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(state.y! + state.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })
  it('pulls back an off-screen window (monitor unplugged)', () => {
    const state = clampToWorkArea({ width: 1280, height: 820, x: 5000, y: -2000, maximized: false }, workArea)
    expect(state.x).toBeLessThanOrEqual(workArea.x + workArea.width - 100)
    expect(state.y).toBeGreaterThanOrEqual(workArea.y)
  })
  it('shrinks an oversized window to the work area', () => {
    const state = clampToWorkArea({ width: 4000, height: 2000, x: 0, y: 0, maximized: false }, workArea)
    expect(state.width).toBeLessThanOrEqual(workArea.width)
    expect(state.height).toBeLessThanOrEqual(workArea.height)
  })
  it('returns geometry without position when given none', () => {
    const state = clampToWorkArea({ width: 1280, height: 820, maximized: false }, workArea)
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
  })
})

describe('isRestorableState', () => {
  it('accepts a valid serialized state and rejects junk', () => {
    expect(isRestorableState({ width: 1280, height: 820, x: 1, y: 2, maximized: false })).toBe(true)
    expect(isRestorableState({ width: 1280, height: 820, maximized: true })).toBe(true)
    expect(isRestorableState(null)).toBe(false)
    expect(isRestorableState('state')).toBe(false)
    expect(isRestorableState({ width: 'wide', height: 820, maximized: false })).toBe(false)
    expect(isRestorableState({ width: 1280, height: 820 })).toBe(false)
    expect(isRestorableState({ width: 1280, height: 820, maximized: 'yes' })).toBe(false)
  })
  it('narrows the type for the caller', () => {
    const raw: unknown = { width: 800, height: 600, x: 0, y: 0, maximized: false }
    if (isRestorableState(raw)) {
      const state: WindowState = raw
      expect(state.width).toBe(800)
    } else {
      expect.unreachable()
    }
  })
})
