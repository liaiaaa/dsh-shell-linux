import { existsSync } from 'node:fs'
import { build } from 'esbuild'

// The preload entry lands in Task 8. Until then `npm start` must still build, so a
// missing entry is a skip rather than a hard failure; once the file exists esbuild
// takes over with no change to this script.
if (!existsSync('src/preload/app.ts')) {
  console.log('preload entry src/preload/app.ts is absent; skipping preload bundle (nothing to build yet)')
  process.exit(0)
}

await build({
  entryPoints: ['src/preload/app.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: 'dist/preload/app.cjs',
})
console.log('preload bundled -> dist/preload/app.cjs')
