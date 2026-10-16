import { describe, expect, it } from 'vitest'
import { DESKTOP_IPC, isHostEvent } from '../src/shared/ipc.ts'

describe('isHostEvent', () => {
  it('accepts ready with url', () => {
    expect(isHostEvent({ type: 'ready', url: 'http://127.0.0.1:4567/?token=x' })).toBe(true)
    expect(isHostEvent({ type: 'ready', url: 'http://127.0.0.1:4567/', injections: [] })).toBe(true)
  })
  it('rejects ready without url', () => {
    expect(isHostEvent({ type: 'ready' })).toBe(false)
    expect(isHostEvent({ type: 'ready', url: 42 })).toBe(false)
  })
  it('accepts fatal message with optional diagnostic', () => {
    expect(isHostEvent({ type: 'fatal', message: 'boom' })).toBe(true)
    expect(isHostEvent({ type: 'fatal', message: 'boom', diagnostic: 'stack' })).toBe(true)
    expect(isHostEvent({ type: 'fatal' })).toBe(false)
  })
  it('accepts platform-login open/close', () => {
    expect(isHostEvent({ type: 'platform-login', request: { action: 'open', url: 'https://platform.deepseek.com/x' } })).toBe(true)
    expect(isHostEvent({ type: 'platform-login', request: { action: 'close', focus: true } })).toBe(true)
    expect(isHostEvent({ type: 'platform-login', request: { action: 'open' } })).toBe(false)
    expect(isHostEvent({ type: 'platform-login', request: { action: 'close', focus: 'yes' } })).toBe(false)
  })
  it('accepts shutdown-complete and rejects junk', () => {
    expect(isHostEvent({ type: 'shutdown-complete' })).toBe(true)
    expect(isHostEvent({ type: 'nope' })).toBe(false)
    expect(isHostEvent('ready')).toBe(false)
    expect(isHostEvent(null)).toBe(false)
  })
})

describe('DESKTOP_IPC', () => {
  it('exposes the caption menu popup channel', () => {
    expect(DESKTOP_IPC.menuPopup).toBe('desktop:menu-popup')
  })
  it('keeps every channel name unique', () => {
    const names = Object.values(DESKTOP_IPC)
    expect(new Set(names).size).toBe(names.length)
  })
})
