import { clampScore, extractSchemaTypes } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

export function analyzeDefinitionBlocks(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const headingNodes = context.$('h1, h2, h3, h4')
  let definitionHeadingCount = 0

  headingNodes.each((_, element) => {
    const text = context.$(element).text().trim().toLowerCase()
    if (text.startsWith('what is') || text.startsWith('how to') || text.startsWith('why')) {
      definitionHeadingCount += 1
    }
  })

  if (definitionHeadingCount >= 2) {
    score += 30
    findings.push({ type: 'found', code: 'definition-blocks.headings.multiple', message: 'Multiple definition-style headings detected.' })
  } else if (definitionHeadingCount === 1) {
    score += 18
    findings.push({ type: 'info', code: 'definition-blocks.headings.single', message: 'One definition-style heading detected.' })
  } else {
    findings.push({ type: 'missing', code: 'definition-blocks.headings.missing', message: 'No definition-style headings detected.' })
    recommendations.push('Add sections like "What is..." and "How to..." for direct-answer relevance.')
  }

  let stepLists = 0
  context.$('ol').each((_, element) => {
    const itemCount = context.$(element).find('li').length
    if (itemCount >= 3) {
      stepLists += 1
    }
  })

  if (stepLists > 0) {
    score += 24
    findings.push({ type: 'found', code: 'definition-blocks.lists.found', message: 'Numbered step-by-step list(s) detected.' })
  } else {
    findings.push({ type: 'info', code: 'definition-blocks.lists.none', message: 'No substantial ordered step lists detected.' })
    recommendations.push('Include ordered steps for procedural topics.')
  }

  const schemaTypes = extractSchemaTypes(context.structuredData)
  if (schemaTypes.has('HowTo')) {
    score += 26
    findings.push({ type: 'found', code: 'definition-blocks.schema.found', message: 'HowTo schema detected.' })
  } else {
    findings.push({ type: 'missing', code: 'definition-blocks.schema.missing', message: 'HowTo schema not detected.' })
    recommendations.push('Add HowTo schema where instructional content exists.')
  }

  if (context.$('dl').length > 0) {
    score += 20
    findings.push({ type: 'found', code: 'definition-blocks.dl.found', message: 'Definition list (<dl>) elements detected.' })
  } else {
    findings.push({ type: 'info', code: 'definition-blocks.dl.none', message: 'No <dl> definition lists detected.' })
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}
