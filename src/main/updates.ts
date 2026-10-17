/**
 * DSH update check: compare the installed version against the npm registry and report.
 * The shell never installs anything — the shell references the system dsh by design, so
 * upgrading stays the user's `npm i -g @deepseek-ai/dsh` decision. Registry access uses
 * the injectable fetch so the caller can pick the right network stack.
 */

/**
 * Which dist-tag to query, given the version the user is running.
 *
 * Why this is a function and not a constant: upstream's `latest` tag is NOT where new
 * builds appear. On 2026-10-17 `latest` still pointed at 0.2.0-rc.2 (published 09-29)
 * while `next` had moved on to 0.2.1-rc.1 and `alpha` to 0.2.1-alpha.5, so a user on a
 * prerelease would be told "you are up to date" forever while seven releases went past.
 * A prerelease install therefore follows the prerelease tag; a final release follows
 * `latest`, which is the tag it actually came from.
 *
 * @param localVersion - the installed version, e.g. `0.2.0-rc.2` or `1.0.0`.
 * @returns `next` for a prerelease, `latest` otherwise.
 */
export function distTagForVersion(localVersion: string): 'latest' | 'next' {
  return localVersion.includes('-') ? 'next' : 'latest'
}

/** The registry endpoint for one dist-tag. */
export function registryUrlForTag(tag: 'latest' | 'next'): string {
  return `https://registry.npmjs.org/@deepseek-ai%2Fdsh/${tag}`
}

/** The command that installs what {@link distTagForVersion} chose. */
export function upgradeCommandForTag(tag: 'latest' | 'next'): string {
  return tag === 'next' ? 'npm i -g @deepseek-ai/dsh@next' : 'npm i -g @deepseek-ai/dsh@latest'
}

/** Semver comparison good enough for dist-tags: numeric fields, prerelease ordering. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string): { core: number[]; pre: string[] | null } => {
    const [main, pre] = version.split('-')
    return { core: main.split('.').map(Number), pre: pre === undefined ? null : pre.split('.') }
  }
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  // Same core: a prerelease (1.2.3-rc.1) is older than the release (1.2.3).
  if (a.pre === null && b.pre === null) return false
  if (a.pre === null) return true
  if (b.pre === null) return false
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i]
    const right = b.pre[i]
    if (left === undefined) return true // shorter prerelease list sorts first
    if (right === undefined) return false
    const asNumber = Number(left)
    const asNumberRight = Number(right)
    if (!Number.isNaN(asNumber) && !Number.isNaN(asNumberRight)) {
      if (asNumber !== asNumberRight) return asNumber > asNumberRight
    } else if (left !== right) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return !Number.isNaN(asNumber) ? false : Number.isNaN(asNumberRight) ? left > right : true
    }
  }
  return false
}

export type UpdateCheckResult =
  | { status: 'ok'; latestVersion: string; updateAvailable: boolean; channel: 'latest' | 'next' }
  | { status: 'unreachable'; reason: string }
  | { status: 'error'; reason: string }

export async function checkForDshUpdate(options: {
  localVersion: string
  fetchImpl?: typeof fetch
  channel?: 'latest' | 'next'
}): Promise<UpdateCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  // The channel defaults to whatever the installed version implies, so a caller that does not
  // care gets the right answer and a test can pin it explicitly.
  const channel = options.channel ?? distTagForVersion(options.localVersion)
  try {
    const response = await fetchImpl(registryUrlForTag(channel), { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return { status: 'error', reason: `registry answered ${String(response.status)}` }
    const payload: unknown = await response.json()
    const latest = (payload as { version?: unknown } | null)?.version
    if (typeof latest !== 'string') return { status: 'error', reason: 'registry answer has no version string' }
    return { status: 'ok', latestVersion: latest, updateAvailable: isNewerVersion(latest, options.localVersion), channel }
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code
    if (typeof code === 'string') return { status: 'unreachable', reason: code }
    // A malformed body surfaces as a syntax/TypeError without a `cause.code`: that is an
    // unexpected answer, not an unreachable network.
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}
