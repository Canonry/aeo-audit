# Changelog

## 1.10.0 (2026-05-23)

### Added
- **Sitemap auto-discovery fallback (#32).** When `/sitemap.xml` returns 404, `runSitemapAudit` and the auxiliary fetcher now also try `/sitemap-index.xml` (common on Astro / Next.js / Vercel) and, as a final fallback, parse the `Sitemap:` directive from `/robots.txt`. Previously sites that only published `sitemap-index.xml` got "Sitemap returned HTTP 404." with no audit coverage unless the user passed the explicit URL.
- **Content-negotiation diagnostic (#34, #35).** When an auxiliary file (`/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap.xml`) responds OK to the audit, the fetcher probes once with `Accept: text/markdown` to detect content-negotiation traps where Vercel / Astro / Starlight stacks 307-redirect `.txt` to a non-existent `.md` variant. Any non-2xx response from the markdown probe surfaces an actionable finding so users can fix the negotiation rule rather than the file. (Issue #34's original "UA filtering" hypothesis turned out to be the same content-negotiation root cause — `aeo-audit` already sends `Accept: */*` so it isn't directly affected, but the diagnostic catches the pattern that breaks downstream AI tools that prefer markdown.)
- **Domain-aware schema recommendations (#33).** The `structured-data` and `schema-completeness` analyzers now detect the site category (SaaS / dev tools, e-commerce, local business, service business, blog/content) from JSON-LD, page text keywords, and outbound links, and recommend schemas that match. SaaS sites are no longer told to add `LocalBusiness` schema; the safe fallback when no category is detected is `Organization` instead of `LocalBusiness`.

### Changed
- New `AuxiliaryDiagnostics` field on `AuxiliaryResource` carries the content-negotiation signal. The `AiReadableContent` analyzer surfaces it as a finding and recommendation.

## 1.9.0 (2026-05-21)

### Added
- New optional `lighthouse` factor (weight 8) that wraps Google PageSpeed Insights. Enabled with the `--lighthouse` CLI flag or `includeLighthouse: true` in `runAeoAudit`. Aggregates Lighthouse Performance, Accessibility, and Best Practices (mobile strategy) into a single 0–100 score, and surfaces the five lowest-scoring Lighthouse audits as recommendations.
- Reads an optional `PAGESPEED_API_KEY` environment variable to lift anonymous PSI rate limits.

### Behavior
- `--lighthouse` is rejected when combined with `--sitemap` or `--detect-platform`. Each Lighthouse call takes 15–30s; running it across a 200-page sitemap would push the audit past an hour. Run it on individual pages instead.
- On PSI failure (HTTP error, timeout, network unreachable) the factor scores 0 with a `timeout` or `unreachable` finding so the rest of the audit still produces a usable report.

## 1.8.1 (2026-05-16)

### Changed
- Reduced `ai-readable-content` factor weight from 10% → 5%. The llms.txt / llms-full.txt / robots.txt / sitemap.xml availability signal carries roughly half the influence it did before, since file presence alone is a weak predictor of citation quality compared to schema and content depth.

## 1.8.0 (2026-05-15)

### Added
- New `snippet-eligibility` analyzer (weight 6) — 16th scoring factor. Parses `meta robots`, `meta googlebot`, and `X-Robots-Tag` directives per Google's "AI features and your website" guide. `noindex`, `nosnippet`, and `max-snippet:0` hard-fail the factor because a page must be indexable and snippet-eligible to appear in AI Overviews or AI Mode.

### Documentation
- README note explaining why we keep scoring `llms.txt` and structured data even though Google's AEO guide says they aren't required for Google AI surfaces — other answer engines (ChatGPT, Perplexity, Claude) still rely on them.

## 1.7.1 (2026-05-06)

### Documentation
- README's Programmatic Usage section now documents `runSitemapAudit` alongside `runAeoAudit`. Library users who called `runAeoAudit('https://example.com')` on the homepage missed per-page issues — duplicate singleton `@type`s, JSON parse errors, missing schema on individual templates — because those problems live on subpages. Calling out the scope distinction up front, with a concrete `crossCuttingIssues` / `affectedUrls` example, makes site-wide auditing the obvious choice when one is appropriate.
- Schema mode in `skills/aeo/SKILL.md` now defaults to sitemap mode (`--sitemap --top-issues`) for site-wide schema requests, mirroring the same scope guidance for skill users.

## 1.7.0 (2026-04-30)

### Added
- New `schema-validity` analyzer (weight 5) that flags page-level JSON-LD problems missed by existing factors:
  - Duplicate singleton `@type`s on a page (e.g., two `FAQPage` blocks — Google flags as "Duplicate field" and invalidates rich results)
  - JSON syntax errors in any `<script type="application/ld+json">` block (previously silently swallowed)
  - Empty / whitespace-only JSON-LD `<script>` blocks
- `extractJsonLdBlocks()` helper exported from `analyzers/helpers.js` for richer per-block introspection (index, parse error, top-level `@type`s)

### Behavior
- When the validator finds a structural error (duplicate singleton or JSON parse error), the factor's score is capped at `69` so the issue surfaces in text-mode top recommendations regardless of how many other factors are also failing — schema errors must be visible irrespective of the numeric score.

## 1.0.3 (2026-03-06)

### Changed
- Replaced the split skill set with one umbrella `aeo` skill covering audit, fix, schema, llms, and monitor modes
- Made `skills/aeo/SKILL.md` the canonical skill source for both npm packaging and ClawHub publishing
- Included the umbrella skill source in the npm package

## 1.0.0 (2026-03-03)

### Added
- Initial release extracted from AINYC website repo
- 13 core scoring factors + 1 optional (geographic signals)
- 4 new analyzers: E-E-A-T Signals, AI Crawler Access, Schema Completeness, Content Extractability
- CLI with text, JSON, and markdown output formats
- 5 Claude Code skills: aeo-audit, aeo-fix, aeo-schema-validate, aeo-llms-generate, aeo-monitor
- CI/CD with GitHub Actions
