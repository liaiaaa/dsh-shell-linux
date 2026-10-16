#!/usr/bin/env node
/**
 * Generate the application icons from the DSH frontend's own SVG assets.
 *
 * The official desktop icon is a black whale on a white field, so this pairs
 * `favicon.svg` (the black whale, meant for light surfaces) with a white
 * background. `favicon-dark.svg` is the inverse (white whale) and is used only
 * by the web UI's dark-mode favicon — not here.
 *
 * Rendering needs an SVG rasteriser; `sharp` ships with the system DSH, so we
 * borrow it rather than adding a dependency to this project.
 *
 * Usage: node scripts/build-icons.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frontendDist } from '../dist/node/shared/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')

// sharp is not a dependency of this project; resolve it from the DSH install.
const anchorRequire = createRequire(join(frontendDist(), 'index.html'))
const sharp = anchorRequire('sharp')

/** The whale silhouette for light backgrounds: a single black path. */
const WHALE = join(frontendDist(), 'favicon.svg')
/** Fraction of the canvas the whale occupies; the rest is the white margin. */
const WHALE_SCALE = 0.74
/** Corner radius as a fraction of the tile size — the official tile's rounding. */
const CORNER_RADIUS = 0.185
const BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 }

const sizes = [
  [128, 'assets/icon-128.png'],
  [256, 'assets/icon.png'],
  [512, 'assets/icon-512.png'],
]

const svg = readFileSync(WHALE)
// Rasterise once at high density, then downscale: the source viewBox is only 50x50.
const master = await sharp(svg, { density: 1200 }).resize(1024, 1024).png().toBuffer()

for (const [size, relative] of sizes) {
  const whale = await sharp(master).resize(Math.round(size * WHALE_SCALE)).png().toBuffer()
  const inset = Math.round((size - size * WHALE_SCALE) / 2)
  // The white field is a rounded square with transparent outside corners, so the
  // icon reads as the official app tile rather than a hard-edged square.
  const radius = Math.round(size * CORNER_RADIUS)
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}"/></svg>`,
  )
  const tile = await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
  const out = join(projectRoot, relative)
  await sharp(tile)
    .composite([{ input: whale, top: inset, left: inset }])
    .png()
    .toFile(out)
  console.log(`icon ${String(size).padStart(3)}x${String(size).padEnd(3)} -> ${relative}`)
}
console.log('done; run scripts/install-desktop.sh to publish them to the menu')
