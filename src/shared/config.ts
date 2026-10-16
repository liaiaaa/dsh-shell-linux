import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

export const DEFAULT_INSTALL_ANCHOR = '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'

export function installAnchor(): string {
  return process.env.DSH_INSTALL_ANCHOR ?? DEFAULT_INSTALL_ANCHOR
}

/**
 * Where the shipped frontend lives, for either install layout.
 *
 * The anchor is the installed DSH's own package.json, so the frontend is a sibling of the
 * packages next to it. Two layouts exist in the wild, and both must work:
 *
 *   nested  (0.2.0-rc.2 and earlier, and any pnpm-style tree):
 *     <prefix>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist
 *   flat    (0.2.1-alpha.2 onward, npm hoisting the shared package to the top level):
 *     <prefix>/node_modules/@deepseek-ai/dsh-web-frontend/dist
 *
 * Returning the wrong one serves 404 for every asset and the window stays blank, so this
 * probes for the real directory instead of assuming the layout. The nested path is tried
 * first: when both exist they are the same install, and that is the layout this project has
 * shipped against. When neither exists the nested path is returned unchanged, so the
 * existing 404 behavior (and its tests) stay exactly as they were.
 *
 * @param exists - injected for tests; defaults to node:fs existsSync.
 */
export function frontendDist(exists: (path: string) => boolean = existsSync): string {
  const anchorDir = dirname(installAnchor())
  const nested = join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
  // One level up from `@deepseek-ai/dsh` is the prefix's own `node_modules/@deepseek-ai`,
  // which is where npm hoists the frontend in the flat layout.
  const flat = join(anchorDir, '..', 'dsh-web-frontend', 'dist')
  return exists(flat) && !exists(nested) ? flat : nested
}

/** The installed DSH's own version, read from its package.json (the install anchor). */
export function installedDshVersion(): string {
  const raw: unknown = JSON.parse(readFileSync(installAnchor(), 'utf8'))
  const version = (raw as { version?: unknown }).version
  if (typeof version !== 'string') throw new Error(`install anchor ${installAnchor()} has no version string`)
  return version
}
