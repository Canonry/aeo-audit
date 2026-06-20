#!/usr/bin/env node
/**
 * Small glue between the aeo-audit CLI and the GitHub Action. It does NOT compute
 * any verdict — that is owned by `aeo-audit compare` (typed + vitest-tested). It
 * only:
 *   --extract-score   <report.json>   → prints the report's headline score
 *   --extract-outputs <compare.json>  → prints `key=value` lines for $GITHUB_OUTPUT
 *
 * Plain CommonJS with zero dependencies so it runs on any runner without an install.
 */
'use strict'

const fs = require('node:fs')

function die(message) {
  process.stderr.write(`render-comment: ${message}\n`)
  process.exit(1)
}

function readJson(path) {
  let raw
  try {
    raw = fs.readFileSync(path, 'utf-8')
  } catch {
    die(`could not read ${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    die(`invalid JSON in ${path}`)
  }
}

/** A single line, safe to write as `key=value` into $GITHUB_OUTPUT. */
function oneLine(value) {
  return String(value).replace(/\r?\n/g, ' ').trim()
}

const mode = process.argv[2]
const file = process.argv[3]
if (!mode || !file) die('usage: render-comment.cjs <--extract-score|--extract-outputs> <file>')

if (mode === '--extract-score') {
  const report = readJson(file)
  const score = typeof report.aggregateScore === 'number' ? report.aggregateScore : report.overallScore
  process.stdout.write(`${score ?? ''}`)
  process.exit(0)
}

if (mode === '--extract-outputs') {
  const r = readJson(file)
  const gatingDefects = Array.isArray(r.newDefects)
    ? r.newDefects.filter((d) => d && d.kind !== 'new-page')
    : []
  const newCritical = gatingDefects.filter((d) => d.severity === 'critical').length
  const regressedFactorIds = Array.isArray(r.regressedFactors)
    ? [...new Set(r.regressedFactors.map((f) => f.id))].join(',')
    : ''
  const lines = [
    `result=${oneLine(r.result ?? '')}`,
    `verdict=${oneLine(r.verdict ?? '')}`,
    `score=${oneLine(r.currentScore ?? '')}`,
    `baseline_score=${oneLine(r.baselineScore ?? '')}`,
    `delta=${oneLine(r.overall ? r.overall.delta : '')}`,
    `regression_count=${oneLine(r.regressionCount ?? 0)}`,
    `regressed_factors=${oneLine(regressedFactorIds)}`,
    `new_critical=${oneLine(newCritical)}`,
    `dropped_pages=${oneLine(Array.isArray(r.droppedPages) ? r.droppedPages.length : 0)}`,
    `removed_pages=${oneLine(Array.isArray(r.removedPages) ? r.removedPages.length : 0)}`,
    `schema_drift=${oneLine(r.schemaDrift ?? 'none')}`,
    `engine_drift=${oneLine(r.engineDrift ?? 'unknown')}`,
    `fail_reason=${oneLine((r.failReasons ?? []).join(' | '))}`,
  ]
  process.stdout.write(lines.join('\n') + '\n')
  process.exit(0)
}

die(`unknown mode ${mode}`)
