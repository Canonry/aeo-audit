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

console.log(report.overallGrade) // 'A+'
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

console.log(report.aggregateGrade)   // 'B+'
console.log(report.pagesAudited)     // 22
console.log(report.crossCuttingIssues) // Per-factor rollup with affectedUrls for every recommendation
console.log(report.prioritizedFixes)   // Top 5 fixes ranked by site-wide impact
```

Each entry in `crossCuttingIssues[].topIssues` carries a `recommendation` plus the exact `affectedUrls` so you can attribute each problem to specific pages, e.g. "FAQPage duplicate" pointing at every blog post that has it.

## Static output (offline, from disk)

```ts
import { runStaticAudit } from '@ainyc/aeo-audit'

const result = await runStaticAudit('./out', {
  baseUrl: 'https://example.com', // maps files to page URLs (default https://localhost)
  limit: 200,                     // max HTML files when the path is a directory
})

if (result.kind === 'single') {
  console.log(result.report.overallGrade)   // single .html file → AuditReport
} else {
  console.log(result.report.aggregateGrade) // directory → SitemapAuditReport shape
  console.log(result.report.crossCuttingIssues)
}
```

`runStaticAudit` performs no network I/O. Coverage is partial: server-only signals (redirects, `X-Robots-Tag`, `Last-Modified`, `Link` headers) aren't visible from static files.
