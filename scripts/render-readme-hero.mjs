#!/usr/bin/env node
// Renders docs/images/readme/hero.svg, the terminal image at the top of the
// README, from a real audit of the sample site in test/fixtures/site.
//
//   pnpm run build && node scripts/render-readme-hero.mjs
//
// The audit runs this checkout's build with the arguments shown in the image,
// from a scratch directory where ./out holds the sample site. Rerun it when the
// text report changes.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, 'docs/images/readme/hero.svg')
const args = ['./out/index.html', '--base-url', 'https://acme-robotics.example']
const shownCommand = `npx @canonry/agent-readiness ${args.join(' ')}`

const COLUMNS = 100
const FONT_SIZE = 14
const CHAR_WIDTH = 8.43
const LINE_HEIGHT = 20
const PAD_X = 24
const TITLE_BAR = 36
const PAD_TOP = 18
const PAD_BOTTOM = 14

const COLORS = { default: '#e6edf3', 31: '#f85149', 32: '#3fb950', 33: '#d29922', 36: '#39c5cf' }
const DIM_OPACITY = 0.45

function runAudit() {
  const work = mkdtempSync(path.join(tmpdir(), 'agent-readiness-hero-'))
  try {
    cpSync(path.join(root, 'test/fixtures/site'), path.join(work, 'out'), { recursive: true })
    try {
      return execFileSync(process.execPath, [path.join(root, 'bin/agent-readiness.js'), ...args], {
        cwd: work,
        encoding: 'utf8',
      })
    } catch (error) {
      // The CLI prints the report, then exits 1 when the score is below 70.
      if (typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout
      throw error
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Split one line of ANSI-colored text into styled characters. */
function styledChars(line, state) {
  const chars = []
  const pattern = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g')
  let last = 0
  for (const match of line.matchAll(pattern)) {
    for (const ch of line.slice(last, match.index)) chars.push({ ch, ...state })
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) Object.assign(state, { bold: false, dim: false, color: 'default' })
      else if (code === 1) state.bold = true
      else if (code === 2) state.dim = true
      else if (code === 22) Object.assign(state, { bold: false, dim: false })
      else if (code === 39) state.color = 'default'
      else if (COLORS[code]) state.color = code
    }
    last = match.index + match[0].length
  }
  for (const ch of line.slice(last)) chars.push({ ch, ...state })
  return chars
}

/** Wrap at the terminal width, breaking at the last space that fits. */
function wrap(chars) {
  const rows = []
  let rest = chars
  while (rest.length > COLUMNS) {
    const text = rest.map((c) => c.ch).join('')
    const space = text.lastIndexOf(' ', COLUMNS)
    const cut = space > 0 ? space : COLUMNS
    rows.push(rest.slice(0, cut))
    rest = rest.slice(space > 0 ? cut + 1 : cut)
  }
  rows.push(rest)
  return rows
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * One terminal row. Each run of same-styled characters is its own <text>,
 * placed at its column and stretched to exactly its width in columns, so the
 * columns line up whatever monospace font the viewer has.
 */
function svgRow(chars, y) {
  const runs = []
  let start = 0
  while (start < chars.length) {
    let end = start + 1
    const a = chars[start]
    while (end < chars.length && ['bold', 'dim', 'color'].every((k) => chars[end][k] === a[k])) end += 1
    const raw = chars.slice(start, end).map((c) => c.ch).join('')
    const text = raw.trim()
    const column = start + (raw.length - raw.trimStart().length)
    if (/^█+$/.test(text)) {
      // A solid bar segment: one rectangle, so stretched glyphs leave no seams.
      const x = (PAD_X + column * CHAR_WIDTH).toFixed(2)
      const width = (text.length * CHAR_WIDTH).toFixed(2)
      runs.push(`<rect x="${x}" y="${y - 11}" width="${width}" height="13" fill="${COLORS[a.color]}"/>`)
    } else if (text.length > 0) {
      const attrs = [
        `x="${(PAD_X + column * CHAR_WIDTH).toFixed(2)}"`,
        `y="${y}"`,
        `textLength="${(text.length * CHAR_WIDTH).toFixed(2)}"`,
        'lengthAdjust="spacingAndGlyphs"',
        `fill="${COLORS[a.color]}"`,
      ]
      if (a.bold) attrs.push('font-weight="700"')
      if (a.dim) attrs.push(`fill-opacity="${DIM_OPACITY}"`)
      runs.push(`<text ${attrs.join(' ')} xml:space="preserve">${escapeXml(text)}</text>`)
    }
    start = end
  }
  return runs.join('')
}

const output = runAudit().replace(/\r/g, '').replace(/\n+$/, '')
const state = { bold: false, dim: false, color: 'default' }
const prompt = styledChars(`\x1b[32m\x1b[1m$\x1b[0m ${shownCommand}`, { bold: false, dim: false, color: 'default' })
const rows = [...wrap(prompt), ...output.split('\n').flatMap((line) => wrap(styledChars(line, state)))]

const width = Math.ceil(PAD_X * 2 + COLUMNS * CHAR_WIDTH)
const height = TITLE_BAR + PAD_TOP + rows.length * LINE_HEIGHT + PAD_BOTTOM
const firstBaseline = TITLE_BAR + PAD_TOP + FONT_SIZE
const description =
  'An agent-readiness audit of the sample site in a terminal: the overall score, a bar for each of the 16 factors, ' +
  'a summary, and the top recommendations, with sample data.'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">agent-readiness audit of a sample site</title>
<desc id="desc">${escapeXml(description)}</desc>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
<path d="M0.5 ${TITLE_BAR}H${width - 0.5}" stroke="#30363d"/>
<circle cx="20" cy="${TITLE_BAR / 2}" r="6" fill="#ff5f57"/><circle cx="40" cy="${TITLE_BAR / 2}" r="6" fill="#febc2e"/><circle cx="60" cy="${TITLE_BAR / 2}" r="6" fill="#28c840"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace">
<text x="${width / 2}" y="${TITLE_BAR / 2 + 4}" text-anchor="middle" font-size="12" fill="#7d8590">agent-readiness</text>
<g font-size="${FONT_SIZE}">
${rows.map((chars, i) => svgRow(chars, firstBaseline + i * LINE_HEIGHT)).join('\n')}
</g>
</g>
</svg>
`

mkdirSync(path.dirname(outFile), { recursive: true })
writeFileSync(outFile, svg)
console.log(`Wrote ${path.relative(root, outFile)} (${rows.length} rows, ${width}x${height})`)
