# CLI reference

```bash
npx @ainyc/aeo-audit <url|path> [options]
```

Pass a **URL** to audit a live site, or a **filesystem path** (a `.html` file or a directory of built HTML, e.g. `./out`) to audit static output offline.

Exit code is `0` when the score is ≥ 70 and `1` when it's below (CI-friendly). See [Exit codes](#exit-codes) for the full rules.

## Output formats

```bash
# Colored terminal output (default)
npx @ainyc/aeo-audit https://example.com

# JSON output (for CI/CD)
npx @ainyc/aeo-audit https://example.com --format json

# Markdown report
npx @ainyc/aeo-audit https://example.com --format markdown

# Agent summary: the slim JSON decision, not the full report
npx @ainyc/aeo-audit https://example.com --sitemap --format agent
```

`--format json` is the contract for programmatic and agent consumers: every report carries a `schemaVersion` (so a parser can detect breaking shape drift) and sitemap reports expose a `criticalDefects` rollup plus a ranked `prioritizedFixes` array of structured objects. See [api.md](api.md#machine-readable-output-for-ai-agents) for the field shapes.

`--format agent` returns just the decision, not the report: `{ schemaVersion, tool, mode, url, score, pass, criticalDefectCount, issues }`, where `issues` is the ranked `PrioritizedFix[]` (critical defects first, then cross-cutting by prevalence). It omits the per-factor and per-page detail so an agent can act without averaging and re-ranking scores itself. Works for single-URL, sitemap, and static-output audits; in `--detect-platform` mode it falls back to the structured JSON.

## Running a subset of factors

```bash
# Run specific factors only
npx @ainyc/aeo-audit https://example.com --factors structured-data,faq-content

# Validate JSON-LD blocks for parse errors and duplicate singleton @types
# (catches issues like duplicate FAQPage that Google flags as invalid)
npx @ainyc/aeo-audit https://example.com --factors schema-validity
```

Factor IDs are listed in [scoring.md](scoring.md).

## Optional factors

```bash
# Geographic signals (LocalBusiness geo data, address, areaServed)
npx @ainyc/aeo-audit https://example.com --include-geo

# Agent skill exposure (Schema.org Action, MCP, A2A cards, form affordances)
npx @ainyc/aeo-audit https://example.com --include-agent-skills

# Lighthouse (Performance + A11y + Best Practices, mobile) via Google PageSpeed
# Insights. Adds ~15-30s. Single-URL only (cannot combine with --sitemap).
npx @ainyc/aeo-audit https://example.com --lighthouse

# Provide a PageSpeed Insights API key to lift anonymous rate limits
PAGESPEED_API_KEY=xxx npx @ainyc/aeo-audit https://example.com --lighthouse --format json
```

See [scoring.md](scoring.md#optional-factors) for what each optional factor measures.

## CI gating

```bash
# Force exit 1 when the meta description is missing (on top of the score gate)
npx @ainyc/aeo-audit https://example.com --require-meta
npx @ainyc/aeo-audit https://example.com --sitemap --require-meta
```

## Sitemap mode

Audit every page discovered from the site's sitemap with bounded concurrency (5 in flight):

```bash
# Auto-discover the sitemap (tries /sitemap.xml, then /sitemap-index.xml,
# then the Sitemap: directive in /robots.txt)
npx @ainyc/aeo-audit https://example.com --sitemap

# Provide an explicit sitemap URL
npx @ainyc/aeo-audit https://example.com --sitemap https://example.com/sitemap.xml

# Cap the number of pages (default 200, sorted by sitemap priority)
npx @ainyc/aeo-audit https://example.com --sitemap --limit 50

# Skip per-page output and show only the cross-cutting issues and critical defects
npx @ainyc/aeo-audit https://example.com --sitemap --top-issues

# Rewrite each <loc>'s origin to the target you named (audit staging with prod's sitemap)
npx @ainyc/aeo-audit https://staging.example.com --sitemap --rewrite-sitemap-origin

# Audit a whole local dev server: rewrite the sitemap onto localhost and unblock it
npx @ainyc/aeo-audit http://localhost:3000 --sitemap --rewrite-sitemap-origin --allow-local
```

Auto-discovery checks `/sitemap.xml` → `/sitemap-index.xml` → `Sitemap:` directives in `/robots.txt`. Astro / Next.js / Vercel sites that only publish `sitemap-index.xml` are discovered without needing an explicit URL.

`--rewrite-sitemap-origin` re-homes every `<loc>` onto the origin of the target URL you passed (preserving path and query) before crawling. Use it when a sitemap hardcodes the canonical/prod domain but you want to audit a different origin that serves the same paths: a staging host, or a local dev server. Every crawled URL is pinned to the origin you explicitly named, so there's no SSRF cost; combined with `--allow-local` it makes a local dev server's whole sitemap auditable in one command.

When the sitemap has more URLs than `--limit`, the run audits the highest-priority pages and prints a notice to stderr listing how many were skipped and how to audit them all.

A **Critical Defects** section lists binary, one-line-fix structural defects (an `<h1>` count other than one, a missing `<title>`, a missing meta description) surfaced **regardless of how few pages they affect**, with the offending pages named (homepage and high sitemap-`priority` pages first). These would otherwise be averaged into a passing factor score and excluded from the prevalence-ranked fixes; the critical-severity ones also lead the prioritized fix list. The section is shown even with `--top-issues`. See the machine-readable shapes in [api.md](api.md#machine-readable-output-for-ai-agents).

The optional in-process factors are honored per page: pass `--include-geo` and/or `--include-agent-skills` to add them to every audited page. `--lighthouse` is the exception: it cannot be combined with `--sitemap` because each PageSpeed Insights call takes 15-30s.

## Static-output mode

Point the CLI at a filesystem path instead of a URL to audit built HTML directly: no network, ideal for CI on a `next export` / `dist` / `out` directory:

```bash
# Audit a whole built directory (aggregated like sitemap mode)
npx @ainyc/aeo-audit ./out

# Map files to real URLs so canonical / og:url checks are meaningful
npx @ainyc/aeo-audit ./out --base-url https://example.com

# A single built file
npx @ainyc/aeo-audit ./dist/index.html

# Gate CI on a missing meta description across the build
npx @ainyc/aeo-audit ./out --require-meta
```

A `.html`/`.htm` file produces a single-page report; a directory is walked for HTML files and aggregated like sitemap mode (`--limit`, `--top-issues`, `--factors`, `--include-geo`, `--include-agent-skills`, and `--require-meta` all apply). `index.html` maps to its directory URL (`out/about/index.html` → `<base>/about/`); other files drop the extension (`out/blog/post.html` → `<base>/blog/post`). `llms.txt`, `llms-full.txt`, `robots.txt`, and `sitemap.xml` are read from the directory root when present.

Coverage is **partial by design**: server-only signals (redirects, `X-Robots-Tag`, `Last-Modified`, `Link` headers) aren't visible from static files, so factors that depend on them score as if the header were absent. Audit the deployed URL for full coverage.

## Compare mode (regression gate)

`aeo-audit compare` is a subcommand that diffs two `--format json` reports — a **baseline** and a **current** run — into a regression verdict and a CI-friendly exit code. It runs no audit and touches no network; it reads reports you already produced. The same `compare` call works in any CI, a pre-commit hook, or a local shell — it is the engine behind the AEO regression GitHub Action.

```bash
# 1. Produce a current report (static-output mode shown; any mode's json works)
npx @ainyc/aeo-audit ./out --base-url https://example.com --format json > current.json

# 2. Diff it against a stored baseline; exit 1 if it regressed
npx @ainyc/aeo-audit compare --baseline baseline.json --current current.json

# Tighter overall gate, plus a human Markdown summary for a PR comment
npx @ainyc/aeo-audit compare --baseline base.json --current current.json \
  --overall-tolerance 0 --md-out diff.md

# Committed/artifact baselines: refuse to gate apples-to-oranges (exit 2) if the
# factor set or engine major differs between the two reports
npx @ainyc/aeo-audit compare --baseline base.json --current current.json --strict-comparability
```

A regression is **any** of: the overall/aggregate score dropping more than `--overall-tolerance` (default 2), a single page dropping more than `--page-tolerance` (default 5), a single factor dropping more than `--factor-tolerance` (default 8), a page that was auditing successfully now erroring out, a **new** `severity:critical` defect (`--fail-on-new-critical`, on by default), or a major report-schema change. Score, page, and factor deltas only gate when the two runs are **comparable** (same factor set, no major engine change); otherwise they're reported with a warning rather than failing the build. `missing-meta-description` is `severity:warning`, so it does **not** trip `--fail-on-new-critical` — use `--require-meta` on the audit or `--fail-on warnings` here. Removed pages and new warnings are report-only unless promoted with `--fail-on`. Pass `--report-only` to print the full diff without ever failing (onboarding soak mode), and `--strict-comparability` to turn a factor-set / engine-major mismatch into a hard exit-2 misconfiguration.

Both reports must be the same mode (two single reports, or two multi-page reports); mixing them is a misconfiguration (exit 2). On a first run with no `--baseline`, the result is `no-baseline` and the build passes (use `--on-missing-baseline fail` to block until a baseline is seeded). stdout carries only the `CompareReport` (JSON by default, or Markdown with `--format markdown`); every human diagnostic goes to stderr, so you can pipe stdout straight into a parser. Run `aeo-audit compare --help` for the full option list.

## Platform detection

Detect what platform, CMS, framework, or static site generator a website is built on. Useful for competitor research, lead qualification, and triage before an audit.

```bash
# Identify the stack (WordPress, Webflow, Shopify, Next.js, Vercel, etc.)
npx @ainyc/aeo-audit https://example.com --detect-platform

# JSON for programmatic use
npx @ainyc/aeo-audit https://example.com --detect-platform --format json

# Only show high-confidence matches
npx @ainyc/aeo-audit https://example.com --detect-platform --min-confidence high
```

The detector inspects HTML, response headers, `<meta name="generator">`, script and link sources, and platform-specific globals to fingerprint:

- **CMS:** WordPress, Drupal, Joomla, Ghost, HubSpot, Craft CMS, Sanity, Contentful, Notion
- **Site builders:** Wix, Squarespace, Webflow, Framer, Carrd, Bubble
- **E-commerce:** Shopify, WooCommerce, BigCommerce, Magento, PrestaShop
- **Frameworks:** Next.js, Nuxt, Gatsby, Remix, Astro, SvelteKit, Angular, Vue, React, Ember, Qwik
- **Static site generators:** Hugo, Jekyll, Eleventy, Hexo, Docusaurus, MkDocs
- **Hosting / CDN:** Vercel, Netlify, Cloudflare, GitHub Pages, Fastly, AWS CloudFront

Each detected platform is reported with a confidence bucket (`high`, `medium`, `low`), a numeric score, an optional version, and the list of signals that matched. When no CMS, site builder, or e-commerce platform is found, the report flags the site as `custom-built` (framework and hosting fingerprints are still surfaced for context). Exit code is `0` when at least one platform is detected, `1` otherwise.

### Batch detection

Pass `--urls` to fingerprint many sites in a single run. Pages are fetched with bounded concurrency (5 in flight by default; tune with `--concurrency`).

```bash
# From a file (one URL per line; # comments and blank lines are skipped)
npx @ainyc/aeo-audit --detect-platform --urls urls.txt

# Inline comma-separated list
npx @ainyc/aeo-audit --detect-platform --urls https://a.com,https://b.com,https://c.com

# From stdin
cat urls.txt | npx @ainyc/aeo-audit --detect-platform --urls -

# JSON for downstream processing
npx @ainyc/aeo-audit --detect-platform --urls urls.txt --format json
```

Per-URL fetch errors don't abort the batch: each entry is reported with `status: 'success'` or `status: 'error'`. Exit code is `0` when at least one URL succeeded, `1` otherwise.

## Auditing a local or private target

By default the audit refuses any URL that resolves to a private, loopback, or link-local address. That is the right default for a tool that also runs as a hosted service on arbitrary input. To audit your **own** dev or staging server, pass `--allow-local` (alias `--allow-private`):

```bash
# Audit a local dev server (pass the explicit scheme; bare hosts default to https)
npx @ainyc/aeo-audit http://localhost:3000 --allow-local

# A staging box on a private IP / VPN
npx @ainyc/aeo-audit http://10.0.5.20 --allow-private
```

The relaxation is **scoped to the single host you named on the CLI, and only that host**. It is evaluated per request hop, so a redirect or a sitemap `<loc>` pointing at any *other* private address (cloud metadata at `169.254.169.254`, internal services, …) is still blocked. There is no flag that disables the guard wholesale, and library/service callers that never set it stay fully protected.

## Auxiliary file diagnostics

When fetching `/llms.txt`, `/llms-full.txt`, `/robots.txt`, and `/sitemap.xml` the audit runs a **content-negotiation probe** that surfaces as a finding on the **AI Access Files (llms.txt, sitemap)** factor: if a file returns OK to a bare request but a non-2xx response under `Accept: text/markdown`, the audit reports a content-negotiation trap. This catches Astro / Vercel / Starlight setups that redirect `.txt` → non-existent `.md` for markdown-accepting clients, which makes the file invisible to AI content-extraction tools, even though the file is "present" by every other measure.

## Flag reference

| Flag | Description |
|------|-------------|
| `--format <type>` | Output format: `text` (default), `json`, `markdown`, `agent`. `agent` emits the slim JSON decision (score, pass gate, `criticalDefectCount`, ranked `issues`) for AI agents. |
| `--factors <list>` | Comma-separated factor IDs to run (runs all if omitted) |
| `--include-geo` | Include the optional geographic signals factor |
| `--include-agent-skills` | Include the optional agent skill exposure factor |
| `--lighthouse` | Include the optional Lighthouse factor (Performance + Accessibility + Best Practices, mobile strategy) via Google PageSpeed Insights. Single-URL only; cannot combine with `--sitemap` or `--detect-platform`. Adds ~15-30s. Set `PAGESPEED_API_KEY` env var to lift anonymous rate limits. |
| `--sitemap [url]` | Audit all pages from the sitemap. Auto-discovery tries `/sitemap.xml`, then `/sitemap-index.xml`, then `Sitemap:` directives in `/robots.txt`. Pass an explicit URL to override. |
| `--limit <n>` | Max pages to audit in sitemap mode (default 200, sorted by sitemap priority) |
| `--top-issues` | In sitemap mode, skip per-page output and show only the cross-cutting issues and critical defects |
| `--detect-platform` | Identify the platform/CMS/framework powering the site instead of running an audit |
| `--urls <src>` | In `--detect-platform` mode, run on multiple URLs. `<src>` is a file path (one URL per line), a comma-separated list, or `-` for stdin |
| `--concurrency <n>` | In `--detect-platform` batch mode, max in-flight fetches (default 5) |
| `--min-confidence <lvl>` | In platform-detect mode, only report matches at or above this level: `low` (default), `medium`, `high` |
| `--require-meta` | Exit `1` if any audited page is missing `<meta name="description">`, regardless of the overall score. Works in single-URL, sitemap, and static-output modes. |
| `--allow-local` (alias `--allow-private`) | Allow the single target host you named on the CLI to resolve to a private/loopback IP (e.g. `http://localhost:3000`). Scoped to that one host only; redirects and sitemap `<loc>`s to any other private host stay blocked. |
| `--rewrite-sitemap-origin` | In `--sitemap` mode, rewrite every `<loc>`'s origin to the target URL's origin (preserving path/query) before crawling. For auditing a staging host or local dev server with a sitemap that hardcodes the prod domain. |
| `--base-url <url>` | In static-output mode, the base URL used to map files to page URLs (e.g. `out/about/index.html` → `<base>/about/`). Default `https://localhost`. |
| `-h`, `--help` | Show the help message |

### `compare` subcommand flags

| Flag | Description |
|------|-------------|
| `--current <file>` | Current run's `--format json` report (required) |
| `--baseline <file>` | Baseline `--format json` report to diff against. Omit for a first run (`no-baseline`) |
| `--overall-tolerance <n>` | Max overall/aggregate score drop before failing (default 2) |
| `--page-tolerance <n>` | Max single-page score drop before failing (default 5) |
| `--factor-tolerance <n>` | Max single-factor score drop before failing (default 8) |
| `--fail-on-new-critical` / `--no-fail-on-new-critical` | Fail (or not) on a new `severity:critical` defect. Default on |
| `--fail-on <list>` | Promote report-only dimensions to failures: `removed-pages`, `warnings` (comma-separated) |
| `--on-missing-baseline <m>` | Behaviour when no baseline: `warn` (default) or `fail` |
| `--report-only` | Compute and print the diff but never exit non-zero (soak mode) |
| `--strict-comparability` | Treat a factor-set or major engine-version mismatch as a misconfiguration (exit 2) instead of a non-gating warning. Use for committed/artifact baselines |
| `--md-out <file>` | Also write a human Markdown summary to this file |
| `--format <type>` | stdout format for compare: `json` (default) or `markdown` |

## Exit codes

Exit code `0` for score ≥ 70, `1` for < 70 (CI-friendly). In sitemap and static-directory modes the exit code is based on the aggregate score. In `--detect-platform` mode the exit code is `0` if any platform is detected (or, in batch mode, if any URL succeeded), `1` otherwise. When `--require-meta` is passed, exit is forced to `1` if any audited page lacks `<meta name="description">`, regardless of the score-based rule.

The **`compare` subcommand** has its own exit contract: `0` = no regression, an improvement, or a first run with no baseline; `1` = a regression tripped a gating dimension; `2` = a misconfiguration (report-mode mismatch, an unreadable or invalid report file, a missing `--current`, or — with `--strict-comparability` — an incomparable factor set / engine major). `--report-only` always exits `0`.
