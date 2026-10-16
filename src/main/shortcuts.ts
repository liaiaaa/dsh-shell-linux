/**
 * Shortcut-preference persistence for the renderer's shortcut editor.
 *
 * The frontend (dsh-client-shortcuts) sees `data-platform` and runs as runtime 'desktop',
 * which routes preference reads/writes through `dshDesktop.shortcuts` — the bridge the
 * original shell stubbed away, leaving the editor unable to persist anything. This service
 * owns the coordinator the frontend expects: the very same ShortcutPersistence class the
 * system dsh ships in dsh-client-shortcuts/protocol, resolved from the install anchor so a
 * dsh upgrade carries its (possibly changed) protocol along. Preferences live in the
 * shell's own userData directory — never under ~/.dsh.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installAnchor } from '../shared/config.ts'

/** The subset of the system protocol module this service relies on. */
interface ShortcutProtocol {
  ShortcutPersistence: new (
    storage: { read(): string | null; write(raw: string): void },
    runtime: 'desktop',
    platform: 'windows' | 'macos' | 'linux',
    rereadBeforeWrite: boolean,
    publish: (snapshot: unknown) => void,
  ) => {
    setDefinitions(definitions: readonly unknown[] | null): void
    dispose(): void
    readCurrent(): Promise<unknown>
    edit(edit: unknown, revision: string): Promise<{ status: string; snapshot: unknown }>
  }
  parseShortcutDefinitions(definitions: readonly unknown[]): readonly unknown[]
}

let cachedProtocol: ShortcutProtocol | undefined

function loadProtocol(): ShortcutProtocol | undefined {
  if (cachedProtocol !== undefined) return cachedProtocol
  // The system dsh ships the coordinator; requiring it keeps the shell runtime-free.
  const candidate = join(dirname(installAnchor()), 'node_modules', '@deepseek-ai', 'dsh-client-shortcuts', 'lib', 'protocol.js')
  if (!existsSync(candidate)) return undefined
  const require = createRequire(import.meta.url)
  cachedProtocol = require(candidate) as ShortcutProtocol
  return cachedProtocol
}

export interface ShortcutsService {
  get(definitions: readonly unknown[]): Promise<unknown>
  edit(edit: unknown, revision: string): Promise<{ status: string; snapshot: unknown }>
  subscribe(listener: (snapshot: unknown) => void): () => void
  recording(active: boolean): Promise<void>
  dispose(): void
}

export function createShortcutsService(options: {
  storagePath: string
  platform: 'windows' | 'macos' | 'linux'
  protocol?: ShortcutProtocol
}): ShortcutsService {
  const protocol = options.protocol ?? loadProtocol()
  const subscribers = new Set<(snapshot: unknown) => void>()
  if (protocol === undefined) {
    // Degraded but honest: the editor sees a defaults snapshot it cannot persist, exactly
    // like the web runtime, instead of a bridge that lies about saving.
    const defaults = { status: 'ready', error: null, usingDefaults: true, document: { schemaVersion: 1, profiles: {} } }
    return {
      get: async () => ({ ...defaults, revision: `unavailable-${Date.now()}`, sequence: 0 }),
      edit: async () => ({ status: 'not-ready', snapshot: { ...defaults, revision: '', sequence: 0 } }),
      subscribe: () => () => {},
      recording: async () => {},
      dispose: () => {},
    }
  }
  const persistence = new protocol.ShortcutPersistence(
    {
      read: () => existsSync(options.storagePath) ? readFileSync(options.storagePath, 'utf8') : null,
      write: (raw) => {
        mkdirSync(dirname(options.storagePath), { recursive: true })
        writeFileSync(options.storagePath, raw, 'utf8')
      },
    },
    'desktop', options.platform, true,
    (snapshot) => { for (const listener of [...subscribers]) listener(snapshot) },
  )
  return {
    get: async (definitions) => {
      persistence.setDefinitions(protocol.parseShortcutDefinitions(definitions))
      return persistence.readCurrent()
    },
    edit: (edit, revision) => persistence.edit(edit, revision),
    subscribe: (listener) => { subscribers.add(listener); return () => { subscribers.delete(listener) } },
    recording: async () => {},
    dispose: () => { subscribers.clear(); persistence.dispose() },
  }
}
