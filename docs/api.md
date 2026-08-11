# Programmatic API

The library exposes four audit entry points. Use `runSiteCrawl` when you need a page graph, crawl depth, or internal-link metrics.

Use `runSitemapAudit` when you need only a sitemap score rollup. `runAeoAudit` fetches only the URL that you pass.

TypeScript declaration files are included automatically.

## Single page

```ts
import { runAeoAudit } from '@canonry/aeo-audit'

const report = await runAeoAudit('https://example.com/specific-page', {
  includeGeo: false,         // Include geographic signals (default: false)
  includeAgentSkills: false, // Include agent skill exposure (default: false)
  includeLighthouse: false,  // Include Lighthouse via PageSpeed Insights (default: false; adds ~15-30s)
  factors: undefined,        // Run all factors (or pass array of factor IDs)
  signal: undefined,         // AbortSignal; rejects with the caller's original abort reason
  onOutboundAttempt: undefined, // Observer called before each SSRF-validated outbound GET
  allowPrivateHost: undefined, // Permit ONE named host to resolve to a private/loopback IP (e.g. 'localhost').
                               // Scoped to that exact host; redirects/sitemap entries to other private hosts stay blocked.
})

console.log(report.overallScore) // 98
console.log(report.factors)      // Array of factor results with scores, findings, recommendations
```

## Full site crawl

`runSiteCrawl` starts with the root URL, recursive sitemaps, and sitemap directives from `robots.txt`. It then follows normalized internal HTML links.

The result includes every discoverable URL within the limits. It cannot find a URL that has no link, sitemap entry, or known seed.
The crawl boundary is the root URL's exact host (including any non-default port). Cross-host links and redirects are recorded but never followed. If the root redirects to another host, the result is explicitly partial with `terminationReason: 'root-host-redirect'`; callers should restart with `finalRootUrl` after confirming that host is intended. An off-host `robots.txt` redirect is not followed and appears in `summary.warnings`.

```ts
import { runSiteCrawl } from '@canonry/aeo-audit'

const report = await runSiteCrawl('https://example.com', {
  mode: 'summary',
  maxPages: 5_000,
  maxEdges: 250_000,
  maxDepth: 20,
  requestDelayMs: 0,        // Minimum spacing between request starts
  checkDeadLinks: false,
  onEvent: async (event) => {
    await saveCheckpoint(event)
  },
})

console.log(report.summary.complete)
console.log(report.summary.terminationReason)
console.log(report.summary.pacing)
console.log(report.summary.warnings)
console.log(report.deadLinks.state) // 'disabled'
```

The event handler receives bounded page, edge, progress, metric, and summary batches. Each batch has a stable ID and checksum.

`checkDeadLinks` is false by default. If it is true, the engine reports failed internal targets that the crawl already observed.

The engine never fetches an external link for dead-link analysis. Robots rules match the normalized URL that the crawler actually requests. With robots enabled, a valid `Crawl-delay` raises the effective delay above `requestDelayMs`; waits remain abortable and bounded by `maxDurationMs`.

A false `summary.complete` value means that a declared crawl limit or the exact-host root boundary stopped discovery.

Use `mode: 'full'` for a returned `pages` and `edges` graph. Use summary mode when the event handler stores the graph.

### Link placement

Every anchor edge carries `placementOccurrences?: { navigation, content, unknown }`, which is where the occurrences of that link sat in the page. Placement is read from HTML landmarks, so a nav link and an in-prose link to the same URL with the same anchor text are distinguishable without inferring anything from how often the link repeats across the site.

| Placement | Resolved from |
|---|---|
| `navigation` | `nav` or `aside` at any depth, an unscoped `header` or `footer`, or `role="navigation" \| "banner" \| "contentinfo" \| "complementary"` |
| `content` | `main`, `article`, or `role="main"` |
| `unknown` | The page declares no landmark that answers the question |

**Nearest ancestor wins.** A `nav` inside `main` is `navigation`, and an `article` inside an `aside` is `content`.

**`header` and `footer` are scoped.** Per HTML-AAM a `header` maps to `banner` and a `footer` to `contentinfo` only when the element is not a descendant of `article`, `aside`, `main`, `nav`, or `section`. A blog post's own `<header>` (title, byline) and `<footer>` (author bio, tags) are therefore the post's `content`, not site chrome. A `header` scoped by a bare `section` resolves to `unknown`, since neither element is a placement landmark. `nav` and `aside` are chrome at any depth; the accessible-name condition HTML-AAM puts on a scoped `aside` is deliberately not applied, because whether a pull-quote is furniture should not depend on whether an author wrote an `aria-label`.

**The first recognized ARIA role wins.** `role` is an ordered fallback list, so the engine takes the first token that is a recognized ARIA role and ignores the rest. If that role is a landmark it gives the placement. If it is recognized but not a landmark, the element is **not** a landmark and its tag name is not consulted, because an author role overrides native semantics: `<nav role="button navigation">` is a button, and `<nav role="tablist">` is not navigation. Only when no token is a recognized role does the tag name decide, so `<nav role="totally-made-up">` stays navigation. Abstract roles are not recognized, since authors must not use them.

`unknown` is a deliberate absence of evidence, never a guess. Class names and ids are never consulted, so a `<div class="footer">` on a page with no landmarks reports `unknown` and the caller decides the policy for it.

Counts rather than a single value, because one edge aggregates every occurrence of the same `(from, to)` pair and those occurrences can differ: a page that links a target once from its nav and once from its prose yields `{ navigation: 1, content: 1, unknown: 0 }`. The counts sum to `totalOccurrences` on an `anchor` edge. `redirect` and `canonical` edges carry zeros, because a non-anchor edge has no position in a page.

The field is **optional**, as is `summary.linkPlacementRulesetVersion`. The engine always populates both; a graph captured before this ruleset has neither, so absence is a real state to handle rather than a field to assume.

`summary.linkPlacementRulesetVersion` (`CRAWL_LINK_PLACEMENT_RULESET_VERSION`) versions the landmark rules independently of `crawlSchemaVersion`, so a stored graph can tell a rules change from a shape change.

## Site-wide (sitemap)

```ts
import { runSitemapAudit } from '@canonry/aeo-audit'

const report = await runSitemapAudit('https://example.com', {
  limit: 200,               // Max pages to audit (default 200, sorted by sitemap priority)
  maxFetches: 500,          // Optional cumulative outbound GET budget
  maxDurationMs: 60_000,    // Optional cumulative wall-clock budget
  factors: ['schema-validity', 'structured-data'],  // Optional subset
})

console.log(report.schemaVersion)      // '3.2', JSON shape version (see "Machine-readable output")
console.log(report.aggregateScore)     // 84
console.log(report.pagesAudited)       // 22
console.log(report.criticalDefects)    // Binary per-page defects (multiple/missing H1, missing title/meta), grouped by defect
console.log(report.crossCuttingIssues) // Per-factor rollup with affectedUrls for every recommendation
console.log(report.coverage)           // Sample size + reach behind aggregateScore
console.log(report.templateGroups)     // Pages collapsed into the templates that produced them
console.log(report.prioritizedFixes)   // Ranked PrioritizedFix[]: critical defects first, then cross-cutting by impact
console.log(report.metadata?.partial)  // true when a sitemap budget stopped the run early
```

Each entry in `crossCuttingIssues[].topIssues` carries a `recommendation` plus the exact `affectedUrls` so you can attribute each problem to specific pages, e.g. "FAQPage duplicate" pointing at every blog post that has it. Every issue also carries `bestScore` / `bestPageUrl` (the strongest page for that factor, to propagate from) and a `status` — `sitewide`, `limited`, or `opportunity` — that classifies page-specific factors (FAQ, definitions) so an isolated-but-present FAQ reads as a `limited` tune-up rather than a site-wide gap. Each issue also carries `applicablePages`, `applicableAvgScore`, and `applicableAffectedPages` — the same numbers restricted to the pages the factor applies to, so a page-specific factor is not averaged over pages that were never meant to satisfy it. See [Sitemap aggregation](scoring.md#sitemap-aggregation-cross-cutting-issues-and-page-specific-factors).

`criticalDefects` surfaces **binary structural defects by impact, not prevalence**. The cross-cutting rollup ranks by how many pages a factor affects, so an unambiguous one-line-fix defect on a single important page (a homepage split across four `<h1>`s, or a `/contact-us` page with none) would otherwise be averaged into a passing factor score and excluded from `prioritizedFixes`. Each group names the offending pages (homepage and high sitemap-`priority` pages first), and the critical-severity ones lead `prioritizedFixes`.

### Machine-readable output (for AI agents)

`--format json` and these return values are the contract for programmatic use. The report is built to be acted on, not just rendered:

- **`schemaVersion`** (on `AuditReport` and `SitemapAuditReport`, exported as `SCHEMA_VERSION`) versions the JSON shape independently of the npm version. Pin to it and treat a major bump as breaking; treat its absence as a pre-2.0 report.
- **`prioritizedFixes: PrioritizedFix[]`** is the ranked, pre-computed to-do list, so an agent need not average factor scores and re-rank. Each fix carries a stable `id` (a defect id like `"multiple-h1"` or a factor id like `"technical-seo"`), `kind`, an optional `severity`, the complete `affectedPages` array (never truncated), `affectsHomepage`, `prevalencePct`, and a human `summary`. Cross-cutting fixes also carry `avgScore`, `applicableAvgScore`, `applicablePages`, `bestScore` / `bestPageUrl`, and a `status` (`sitewide` | `limited` | `opportunity`); `limited`/`opportunity` page-specific factors are demoted below genuine site-wide gaps, and a `limited` fix is scoped to the page(s) that carry the factor with the tune-up recommendation from there.
- **`coverage: AuditCoverage`** is what `aggregateScore` was taken over: `pagesAudited` / `pagesDiscovered` / `coveragePct`, whether the run `sampled`, how many URL `templatesDiscovered` and `templatesRepresented`, and a `confidence` of `full` | `representative` | `indicative`. Confidence keys on template reach rather than raw percentage — a 5% sample touching every URL shape generalizes, a 45% prefix that never left one section does not. Crawls select pages stratified across templates, not as a prefix of the sitemap.
- **`templateGroups: TemplateGroup[]`** collapses pages that share a URL shape *and* score alike into the template that produced them, each with a `templateKey`, `pageCount`, `avgScore`, a `representativeUrl` to fix on, and the complete `urls` list. Cross-cutting and critical fixes carry the matching `templateCount` / `instanceCount`, so "194 property pages missing schema" can be costed as the one template edit it is. This is an overlay: per-page results stay complete and no URL is dropped from `affectedPages`.
- **Stable identifiers** everywhere: the decision surface (`criticalDefects[].id`, `prioritizedFixes[].id` / `kind`) and every individual factor finding (`factors[].findings[].code`, e.g. `technical-seo.h1.multiple`) carry stable codes, so integrations key on codes, not on matching message strings. The full code registry is in [finding-codes.md](finding-codes.md).

## Static output (offline, from disk)

```ts
import { runStaticAudit } from '@canonry/aeo-audit'

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
