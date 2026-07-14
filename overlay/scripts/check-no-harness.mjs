#!/usr/bin/env node
// Build-time assertion that the packaged renderer bundle contains no harness
// code (PRD `docs/prd-agent-observability.md` §5.5 risk: "harness leaking
// into production"). `main.tsx` only reaches `harness/` via a dynamic import
// gated on `import.meta.env.VITE_HARNESS`, which electron-vite's production
// build never defines - Vite/Rollup dead-code-eliminate the whole branch. This
// script verifies that actually happened by grepping the built renderer JS for
// a handful of string literals unique to harness modules (minifiers preserve
// string literals verbatim, so their absence is a reliable eliminated-or-not
// signal even after minification strips identifier names). Run as the last
// step of `npm run build` - see `docs/overlay-harness.md`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER_DIR = join(import.meta.dirname, '..', 'out', 'renderer')

// Distinctive string literals that only ever appear inside harness/*.ts(x) -
// chosen to be unlikely to collide with anything in the rest of the codebase.
const HARNESS_MARKERS = [
  'realmshark-harness:',
  '[harness/ws]',
  '[harness/fixture]',
  '__harnessFixtureReady'
]

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain Node script, no tsconfig coverage
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

let files
try {
  files = walk(RENDERER_DIR)
} catch (err) {
  console.error(`[check-no-harness] could not read ${RENDERER_DIR}: ${err.message}`)
  process.exit(1)
}

const hits = []
for (const file of files) {
  const content = readFileSync(file, 'utf8')
  for (const marker of HARNESS_MARKERS) {
    if (content.includes(marker)) hits.push({ file, marker })
  }
}

if (hits.length > 0) {
  console.error('[check-no-harness] harness code found in the production renderer bundle:')
  for (const { file, marker } of hits) {
    console.error(`  ${file}: contains ${JSON.stringify(marker)}`)
  }
  console.error(
    '[check-no-harness] the VITE_HARNESS dynamic-import gate in main.tsx should have tree-shaken this out - see docs/overlay-harness.md.'
  )
  process.exit(1)
}

console.log(
  `[check-no-harness] ok - scanned ${files.length} renderer file(s), no harness markers found`
)
