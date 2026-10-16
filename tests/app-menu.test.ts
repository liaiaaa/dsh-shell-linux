import { describe, expect, it, vi } from 'vitest'
import {
  buildApplicationMenuTemplate,
  buildPopupMenuTemplate,
  isPopupMenuName,
  resolvePopupRequest,
} from '../src/main/app-menu.ts'

const actions = () => ({ checkForUpdates: vi.fn(), showAbout: vi.fn() })

/** Flatten one level of `submenu` into a plain array for assertions. */
function itemsOf(template: readonly Electron.MenuItemConstructorOptions[]): Electron.MenuItemConstructorOptions[] {
  return template.flatMap((item) => (Array.isArray(item.submenu) ? item.submenu : []))
}

describe('buildApplicationMenuTemplate', () => {
  it('keeps F1 and Ctrl+Shift+U as the only global accelerators', () => {
    const a = actions()
    const template = buildApplicationMenuTemplate(a)
    expect(template.map((item) => item.label)).toEqual(['DSH', '帮助'])
    const items = itemsOf(template)
    const byLabel = new Map(items.map((item) => [item.label, item]))
    expect(byLabel.get('关于 dsh-shell-linux')?.accelerator).toBe('F1')
    expect(byLabel.get('检查 DSH 更新…')?.accelerator).toBe('Ctrl+Shift+U')
    // The application menu owns the accelerators; nothing here may opt out of registering.
    expect(items.every((item) => item.registerAccelerator === undefined)).toBe(true)
    // Quit stays a role item so Electron wires the platform behaviour itself.
    expect(items.find((item) => item.label === '退出')?.role).toBe('quit')
    expect(items.some((item) => item.type === 'separator')).toBe(true)
  })
  it('routes clicks to the injected actions', () => {
    const a = actions()
    const items = itemsOf(buildApplicationMenuTemplate(a))
    items.find((item) => item.label === '关于 dsh-shell-linux')?.click?.(undefined as never, undefined as never, undefined as never)
    items.find((item) => item.label === '检查 DSH 更新…')?.click?.(undefined as never, undefined as never, undefined as never)
    expect(a.showAbout).toHaveBeenCalledTimes(1)
    expect(a.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('buildPopupMenuTemplate', () => {
  it('builds the file menu without stealing the global accelerator', () => {
    const items = buildPopupMenuTemplate('file', actions())
    expect(items.map((item) => item.label ?? item.type)).toEqual(['检查 DSH 更新…', 'separator', '退出'])
    const update = items[0]
    expect(update.accelerator).toBe('Ctrl+Shift+U')
    // registerAccelerator:false keeps the hint visible while the application menu stays
    // the sole owner — otherwise the shortcut would fire the dialog twice.
    expect(update.registerAccelerator).toBe(false)
    expect(items.find((item) => item.label === '退出')?.role).toBe('quit')
  })
  it('builds the help menu with the same hint rule', () => {
    const items = buildPopupMenuTemplate('help', actions())
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('关于 dsh-shell-linux')
    expect(items[0].accelerator).toBe('F1')
    expect(items[0].registerAccelerator).toBe(false)
  })
  it('routes clicks to the injected actions', () => {
    const a = actions()
    buildPopupMenuTemplate('file', a)[0].click?.(undefined as never, undefined as never, undefined as never)
    buildPopupMenuTemplate('help', a)[0].click?.(undefined as never, undefined as never, undefined as never)
    expect(a.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(a.showAbout).toHaveBeenCalledTimes(1)
  })
})

describe('isPopupMenuName', () => {
  it('accepts only the two caption menus', () => {
    expect(isPopupMenuName('file')).toBe(true)
    expect(isPopupMenuName('help')).toBe(true)
    expect(isPopupMenuName('edit')).toBe(false)
    expect(isPopupMenuName('')).toBe(false)
    expect(isPopupMenuName(42)).toBe(false)
    expect(isPopupMenuName(null)).toBe(false)
    expect(isPopupMenuName({ name: 'file' })).toBe(false)
  })
})

describe('resolvePopupRequest', () => {
  it('passes a well-formed request through unchanged', () => {
    expect(resolvePopupRequest('file', 12, 40)).toEqual({ name: 'file', x: 12, y: 40 })
    expect(resolvePopupRequest('help', 0, 0)).toEqual({ name: 'help', x: 0, y: 0 })
    expect(resolvePopupRequest('file', 100_000, 100_000)).toEqual({ name: 'file', x: 100_000, y: 100_000 })
  })
  it('rejects an unknown menu name', () => {
    expect(() => resolvePopupRequest('edit', 0, 0)).toThrow('unknown popup menu: edit')
    expect(() => resolvePopupRequest(undefined, 0, 0)).toThrow('unknown popup menu')
  })
  it('rejects non-finite, negative, and out-of-range coordinates', () => {
    expect(() => resolvePopupRequest('file', Number.NaN, 0)).toThrow('invalid popup coordinate x')
    expect(() => resolvePopupRequest('file', Number.POSITIVE_INFINITY, 0)).toThrow('invalid popup coordinate x')
    expect(() => resolvePopupRequest('file', -1, 0)).toThrow('invalid popup coordinate x')
    expect(() => resolvePopupRequest('file', 100_001, 0)).toThrow('invalid popup coordinate x')
    expect(() => resolvePopupRequest('file', 0, '40')).toThrow('invalid popup coordinate y')
    expect(() => resolvePopupRequest('file', 0, Number.NaN)).toThrow('invalid popup coordinate y')
  })
})