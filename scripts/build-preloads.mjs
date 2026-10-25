/**
 * Bundle the preload scripts the shell's own windows need.
 *
 * Both entries are CommonJS bundles with `electron` external: they run before the page and use
 * `contextBridge` to expose a narrow API. A missing entry is a skip rather than a hard failure so
 * `npm start` keeps working on a checkout that has not added the file yet.
 */
import { existsSync } from 'node:fs'
import { build } from 'esbuild'

const entries = [
  { source: 'src/preload/app.ts', output: 'dist/preload/app.cjs' },
  { source: 'src/preload/ui.ts', output: 'dist/preload/ui.cjs' },
]

let built = 0
for (const entry of entries) {
  if (!existsSync(entry.source)) {
    console.log(`preload entry ${entry.source} is absent; skipping (nothing to build for it)`)
    continue
  }
  await build({
    entryPoints: [entry.source],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: entry.output,
  })
  console.log(`preload bundled -> ${entry.output}`)
  built += 1
}
if (built === 0) console.log('no preload entries were present; nothing bundled')
