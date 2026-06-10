# Programmatic API

The library exposes three audit entry points. **Use `runSitemapAudit` for site-wide checks.** `runAeoAudit` only fetches the URL you pass it, so per-page issues like duplicate `FAQPage` blocks, JSON parse errors, or missing schema on individual templates are invisible if you call it on the homepage of a multi-page site.

TypeScript declaration files are included automatically.

## Single page

```ts
import { runAeoAudit } from '@ainyc/aeo-audit'

const report = await runAeoAudit('https://example.com/specific-page', {
  includeGeo: false,         // Include geographic signals (default: false)
  includeAgentSkills: false, // Include agent skill exposure (default: false)
  includeLighthouse: false,  // Include Lighthouse via PageSpeed Insights (default: false; adds ~15-30s)
  factors: undefined,        // Run all factors (or pass array of factor IDs)
  allowPrivateHost: undefined, // Permit ONE named host to resolve to a private/loopback IP (e.g. 'localhost').
                               // Scoped to that exact host; redirects/sitemap entries to other private hosts stay blocked.
})

console.log(report.overallScore) // 98
console.log(report.factors)      // Array of factor results with scores, findings, recommendations
```

## Site-wide (sitemap)

```ts
import { runSitemapAudit } from '@ainyc/aeo-audit'

const report = await runSitemapAudit('https://example.com', {
  limit: 200,               // Max pages to audit (default 200, sorted by sitemap priority)
  factors: ['schema-validity', 'structured-data'],  // Optional subset
})

console.log(report.schemaVersion)      // '2.1', JSON shape version (see "Machine-readable output")
console.log(report.aggregateScore)     // 84
console.log(report.pagesAudited)       // 22
console.log(report.criticalDefects)    // Binary per-page defects (multiple/missing H1, missing title/meta), grouped by defect
console.log(report.crossCuttingIssues) // Per-factor rollup with affectedUrls for every recommendation
console.log(report.prioritizedFixes)   // Ranked PrioritizedFix[]: critical defects first, then cross-cutting by impact
```

Each entry in `crossCuttingIssues[].topIssues` carries a `recommendation` plus the exact `affectedUrls` so you can attribute each problem to specific pages, e.g. "FAQPage duplicate" pointing at every blog post that has it. Every issue also carries `bestScore` / `bestPageUrl` (the strongest page for that factor, to propagate from) and a `status` — `sitewide`, `limited`, or `opportunity` — that classifies page-specific factors (FAQ, definitions) so an isolated-but-present FAQ reads as a `limited` tune-up rather than a site-wide gap. See [Sitemap aggregation](scoring.md#sitemap-aggregation-cross-cutting-issues-and-page-specific-factors).

`criticalDefects` surfaces **binary structural defects by impact, not prevalence**. The cross-cutting rollup ranks by how many pages a factor affects, so an unambiguous one-line-fix defect on a single important page (a homepage split across four `<h1>`s, or a `/contact-us` page with none) would otherwise be averaged into a passing factor score and excluded from `prioritizedFixes`. Each group names the offending pages (homepage and high sitemap-`priority` pages first), and the critical-severity ones lead `prioritizedFixes`.

### Machine-readable output (for AI agents)

`--format json` and these return values are the contract for programmatic use. The report is built to be acted on, not just rendered:

- **`schemaVersion`** (on `AuditReport` and `SitemapAuditReport`, exported as `SCHEMA_VERSION`) versions the JSON shape independently of the npm version. Pin to it and treat a major bump as breaking; treat its absence as a pre-2.0 report.
- **`prioritizedFixes: PrioritizedFix[]`** is the ranked, pre-computed to-do list, so an agent need not average factor scores and re-rank. Each fix carries a stable `id` (a defect id like `"multiple-h1"` or a factor id like `"technical-seo"`), `kind`, an optional `severity`, the complete `affectedPages` array (never truncated), `affectsHomepage`, `prevalencePct`, and a human `summary`. Cross-cutting fixes also carry `avgScore`, `bestScore` / `bestPageUrl`, and a `status` (`sitewide` | `limited` | `opportunity`); `limited`/`opportunity` page-specific factors are demoted below genuine site-wide gaps, and a `limited` fix is scoped to the page(s) that carry the factor with the tune-up recommendation from there.
- **Stable identifiers** everywhere: the decision surface (`criticalDefects[].id`, `prioritizedFixes[].id` / `kind`) and every individual factor finding (`factors[].findings[].code`, e.g. `technical-seo.h1.multiple`) carry stable codes, so integrations key on codes, not on matching message strings. The full code registry is in [finding-codes.md](finding-codes.md).

## Static output (offline, from disk)

```ts
import { runStaticAudit } from '@ainyc/aeo-audit'

const result = await runStaticAudit('./out', {
  baseUrl: 'https://example.com', // maps files to page URLs (default https://localhost)
  limit: 200,                     // max HTML files when the path is a directory
})

if (result.kind === 'single') {
  console.log(result.report.overallScore)   // single .html file → AuditReport
} else {
  console.log(result.report.aggregateScore) // directory → SitemapAuditReport shape
  console.log(result.report.criticalDefects)
  console.log(result.report.crossCuttingIssues)
}
```

`runStaticAudit` performs no network I/O. Coverage is partial: server-only signals (redirects, `X-Robots-Tag`, `Last-Modified`, `Link` headers) aren't visible from static files.
