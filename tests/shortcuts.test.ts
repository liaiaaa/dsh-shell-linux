import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShortcutsService } from '../src/main/shortcuts.ts'

let root: string | undefined
afterEach(() => { if (root !== undefined) { rmSync(root, { recursive: true, force: true }); root = undefined } })

function makeService() {
  root = mkdtempSync(join(tmpdir(), 'dsh-shortcuts-'))
  return createShortcutsService({ storagePath: join(root, 'keybindings.json'), platform: 'linux' as const })
}

const DEFINITIONS = [
  { id: 'page.close', defaults: { 'desktop:linux': { code: 'KeyW', modifiers: ['primary'] } } },
] as never

describe('createShortcutsService', () => {
  it('answers get with a defaults snapshot when nothing was persisted', async () => {
    const service = makeService()
    const snapshot = await service.get(DEFINITIONS)
    expect(snapshot.status).toBe('ready')
    expect(snapshot.usingDefaults).toBe(true)
    expect(snapshot.document.schemaVersion).toBe(1)
  })
  it('persists an edit to the storage file and reads it back in a new service', async () => {
    const service = makeService()
    const first = await service.get(DEFINITIONS)
    const saved = await service.edit(
      { type: 'set', id: 'page.close', binding: { code: 'KeyJ', modifiers: ['primary', 'shift'] } },
      first.revision,
    )
    expect(saved.status).toBe('saved')
    const file = join(root!, 'keybindings.json')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('KeyJ')
    // A fresh service instance (the next app launch) reads the persisted document.
    const second = createShortcutsService({ storagePath: join(root!, 'keybindings.json'), platform: 'linux' as const })
    const reread = await second.get(DEFINITIONS)
    expect(reread.usingDefaults).toBe(false)
    // The document is profile-keyed: { "desktop:linux": { "page.close": {...} } }.
    const profile = (reread.document.profiles as Record<string, Record<string, unknown>>)['desktop:linux']
    expect(profile['page.close']).toEqual({ code: 'KeyJ', modifiers: ['primary', 'shift'] })
  })
  it('rejects a stale revision with a classified save result', async () => {
    const service = makeService()
    await service.get(DEFINITIONS)
    const result = await service.edit({ type: 'set', id: 'page.close', binding: { code: 'KeyQ', modifiers: ['primary'] } }, 'bogus-revision')
    expect(result.status).toBe('stale')
  })
  it('publishes snapshot changes to subscribers', async () => {
    const service = makeService()
    const seen: Array<{ sequence: number }> = []
    const dispose = service.subscribe(snapshot => { seen.push({ sequence: snapshot.sequence }) })
    await service.get(DEFINITIONS)
    expect(seen.length).toBeGreaterThan(0)
    dispose()
  })
  it('resolves editing to a no-op completion for the recording gate', async () => {
    const service = makeService()
    await expect(service.recording(true)).resolves.toBeUndefined()
    await expect(service.recording(false)).resolves.toBeUndefined()
  })
})
