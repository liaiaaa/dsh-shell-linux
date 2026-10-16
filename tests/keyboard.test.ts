import { describe, expect, it } from 'vitest'
import { createDesktopKeyboardBridge } from '../src/preload/keyboard.ts'

describe('createDesktopKeyboardBridge', () => {
  it('forwards closeWindow to the window-control close channel with the revision', async () => {
    const sent: Array<{ channel: string; args: unknown[] }> = []
    const bridge = createDesktopKeyboardBridge((channel, ...args) => { sent.push({ channel, args }) })
    await bridge.closeWindow(7)
    expect(sent).toEqual([{ channel: 'desktop:window-control', args: ['close'] }])
  })
  it('resolves even when the revision is undefined (bridge contract passes it through)', async () => {
    const sent: Array<{ channel: string; args: unknown[] }> = []
    const bridge = createDesktopKeyboardBridge((channel, ...args) => { sent.push({ channel, args }) })
    await expect(bridge.closeWindow(undefined)).resolves.toBeUndefined()
    expect(sent).toHaveLength(1)
  })
  it('subscribe registers and disposes through the ipc surface', () => {
    let registered = 0
    let disposed = 0
    const bridge = createDesktopKeyboardBridge(() => {}, (_channel, handler) => {
      registered++
      return () => { disposed++ ; void handler }
    })
    const dispose = bridge.subscribe(() => {})
    expect(registered).toBe(1)
    dispose()
    expect(disposed).toBe(1)
  })
})
