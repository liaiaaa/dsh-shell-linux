import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * Where a dsh install can live, most preferred first.
 *
 * A machine can end up with more than one, and which one is "the" install is not a property
 * this shell can assume: npm writes to `$(npm config get prefix)/lib/node_modules`, and that
 * prefix is user-configurable, so `sudo npm i -g` (root's prefix, usually /usr/local) and a
 * plain `npm i -g` (a user prefix such as ~/.local) put dsh in different places. Measured on
 * the development machine: a first install landed in /usr/local, then an unrelated
 * `npm config set prefix ~/.local` (made to install bun) moved every later install elsewhere,
 * and upgrading then produced two 883 MB trees.
 *
 * The user prefix comes first because that is what a plain `npm i -g` updates, and `~/.local/bin`
 * precedes /usr/local/bin on PATH here, so "what the shell runs" matches "what `dsh` runs".
 */
export function candidateAnchors(home: string = homedir()): readonly string[] {
  const tail = join('lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  return [join(home, '.local', tail), join('/usr/local', tail)]
}

/**
 * The install to use, chosen by what is actually on disk.
 *
 * `DSH_INSTALL_ANCHOR` still wins outright: it is the escape hatch for a layout neither
 * candidate describes (a pnpm tree, a custom --prefix, a system install somewhere else).
 * Otherwise the first existing candidate is used, and when none exists the first candidate is
 * returned so the resulting error names a path the user can act on.
 *
 * @param exists - injected for tests; defaults to node:fs existsSync.
 * @param home - injected for tests; defaults to the current user's home directory.
 */
export function resolveInstallAnchor(
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.DSH_INSTALL_ANCHOR
  if (override !== undefined && override !== '') return override
  const candidates = candidateAnchors(home)
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0]
}

/** The anchor for this process: the override, or the first install present on disk. */
export function installAnchor(): string {
  return resolveInstallAnchor()
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
