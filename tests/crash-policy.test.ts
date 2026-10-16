import { describe, expect, it } from 'vitest'
import { CrashBackoff } from '../src/main/crash-policy.ts'

describe('CrashBackoff', () => {
  it('allows up to maxReloads crashes in the window, then backs off', () => {
    const backoff = new CrashBackoff({ windowMs: 60_000, maxReloads: 2 })
    expect(backoff.registerAndDecide(1_000)).toBe(true)
    expect(backoff.registerAndDecide(2_000)).toBe(true)
    expect(backoff.registerAndDecide(3_000)).toBe(false)
  })
  it('forgets crashes outside the window (the only form of reset)', () => {
    const backoff = new CrashBackoff({ windowMs: 10_000, maxReloads: 2 })
    expect(backoff.registerAndDecide(1_000)).toBe(true)
    expect(backoff.registerAndDecide(2_000)).toBe(true)
    // Way past the window: the two early crashes no longer count. There is no other
    // reset — a wedged renderer must not be able to defeat the backoff by riding reloads.
    expect(backoff.registerAndDecide(600_000)).toBe(true)
  })
  it('a healthy gap ages the history out without any explicit reset', () => {
    const backoff = new CrashBackoff({ windowMs: 60_000, maxReloads: 2 })
    expect(backoff.registerAndDecide(1_000)).toBe(true)
    expect(backoff.registerAndDecide(2_000)).toBe(true)
    // No reset API exists on purpose: only time heals the history.
    expect(backoff.registerAndDecide(600_000)).toBe(true)
  })
})
