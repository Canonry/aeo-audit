---
name: aeo
description: Run AEO audits, preview branch audits, changed-page sitemap audits, local/private preview audits with explicit opt-in, sitemap origin rewriting, static-output audits, regression comparisons, site fixes, schema validation, and llms.txt generation.
homepage: https://ainyc.ai
repository: https://github.com/Canonry/aeo-audit
allowed-tools:
  - Bash(npx @ainyc/aeo-audit@1 *)
  - Read
  - Glob
  - Grep
  - Write(llms.txt)
  - Write(llms-full.txt)
  - Write(robots.txt)
---

# AEO

Website: [ainyc.ai](https://ainyc.ai)

One skill for audit, preview-branch review, fixes, schema, llms.txt, and monitoring workflows.

## Command

Always use the published package:

```bash
npx @ainyc/aeo-audit@1 "<url>" [flags] --format json
```

## Argument Safety

**Never interpolate user input directly into shell commands.** Always:
1. Validate that the target is either a URL matching `https://` / `http://` or a local filesystem path (static-output mode), and that it contains no shell metacharacters.
2. Quote every argument individually (e.g., `npx @ainyc/aeo-audit@1 "https://example.com" --format json`).
3. Pass flags as separate, literal tokens — never construct command strings from raw user text.
4. Reject arguments containing characters like `;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `<`, `>`, or newlines.

## Modes

- `audit`: score and diagnose a site
- `fix`: apply code changes after an audit
- `schema`: validate JSON-LD and entity consistency
- `llms`: create or improve `llms.txt` and `llms-full.txt`
- `monitor`: compare changes over time, compare a branch preview against production, or benchmark competitors
- `detect-platform`: identify the CMS, site builder, framework, or hosting stack a site uses
- `compare`: diff two saved `--format json` reports into a regression verdict + exit code (CI gate)

If no mode is provided, default to `audit`.

## Examples

- `audit https://example.com`
- `audit https://example.com --sitemap`
- `audit https://example.com --sitemap --limit 10`
- `audit https://example.com --sitemap --top-issues`
- `audit https://example.com --sitemap --format agent` (slim decision for agents)
- `audit https://example.com --lighthouse`
- `audit https://example.com --require-meta`
- `audit https://example.com --sitemap --require-meta`
- `audit http://localhost:3000 --allow-local`
- `audit http://localhost:3000 --sitemap --rewrite-sitemap-origin --allow-local`
- `audit http://localhost:3000 --sitemap --rewrite-sitemap-origin --allow-local --changed --base main --include-critical`
- `audit https://staging.example.com --sitemap --rewrite-sitemap-origin`
- `audit ./out` (static-output mode: audit built HTML offline)
- `audit ./out --base-url https://example.com --require-meta`
- `fix https://example.com`
- `schema https://example.com`
- `llms https://example.com`
- `monitor https://site-a.com --compare https://site-b.com`
- `detect-platform https://example.com`
- `detect-platform https://example.com --min-confidence high`
- `detect-platform --urls competitors.txt`
- `detect-platform --urls https://a.com,https://b.com`
- `compare --baseline baseline.json --current current.json` (fail CI on AEO regression)

## Mode Selection

- If the first argument is one of `audit`, `fix`, `schema`, `llms`, `monitor`, or `detect-platform`, use that mode.
- If no explicit mode is given, infer the intent from the request and default to `audit`.

## Audit

Use for broad requests such as "audit this site" or "why am I not being cited?"

1. Run:
   ```bash
   npx @ainyc/aeo-audit@1 "<url>" [flags] --format json
   ```
2. Return:
   - Overall score
   - Short summary
   - Factor breakdown
   - Top strengths
   - Top fixes
   - Metadata such as fetch time and auxiliary file availability

#### `--require-meta` (CI gate)

Pass `--require-meta` (single or sitemap mode) to force exit `1` whenever any audited page is missing `<meta name="description">`, regardless of the otherwise score-based exit rule. Useful in CI pipelines that need to block deploys on a missing meta description even on otherwise-healthy sites.

### Sitemap Mode

Use `--sitemap` to audit all pages discovered from the site's sitemap:

```bash
npx @ainyc/aeo-audit@1 "<url>" --sitemap --format json
npx @ainyc/aeo-audit@1 "<url>" --sitemap https://example.com/sitemap.xml --format json
npx @ainyc/aeo-audit@1 "<url>" --sitemap --limit 10 --format json
npx @ainyc/aeo-audit@1 "<url>" --sitemap --top-issues --format json
```

Flags:
- `--sitemap [url]` — auto-discover the sitemap (tries `/sitemap.xml`, then `/sitemap-index.xml`, then `Sitemap:` directives in `/robots.txt`) or provide an explicit URL
- `--limit <n>` — cap pages audited (default 200, sorted by sitemap priority)
- `--top-issues` — skip per-page output, show only cross-cutting patterns and critical defects
- `--rewrite-sitemap-origin` — rewrite every `<loc>`'s origin to the target URL's origin (preserving path/query) before crawling. Use when the sitemap hardcodes the prod/canonical domain but you want to audit a staging host or local dev server.
- `--changed` — filter sitemap URLs to static routes changed since `--base`; use for PR work
- `--base <ref>` — git base for `--changed` (default `main`)
- `--include-critical` — add critical paths to the changed-page set
- `--critical-paths <list>` — comma-separated critical paths for `--include-critical`; defaults to `/`
- `--require-meta` — force exit `1` if any audited page is missing `<meta name="description">`, regardless of overall score (useful as a CI gate)
- `--include-geo` / `--include-agent-skills` — honored per page in sitemap mode (adds the optional geographic-signals / agent-skill-exposure factors). `--lighthouse` is not available with `--sitemap`.

Pages are audited with bounded concurrency (5 in flight) to avoid hammering the target origin.

Returns:
- Per-page scores
- **Critical defects** — binary, one-line-fix structural defects (an `<h1>` count other than one, a missing `<title>`, a missing meta description) surfaced **regardless of how few pages they affect**, with the offending pages named (homepage and high sitemap-`priority` pages first). These would otherwise be averaged into a passing factor score; the JSON field is `criticalDefects` and critical-severity ones are also promoted to the top of `prioritizedFixes`. Shown even with `--top-issues`.
- Cross-cutting issues (factors failing across multiple pages), each with the best-scoring page (`bestScore`/`bestPageUrl`) and a `status`: `sitewide` (a real coverage gap) vs. `limited`/`opportunity` for page-specific factors (FAQ, definitions) that legitimately apply to only some page types
- Aggregate score
- Prioritized fixes (critical defects first, then site-wide gaps; page-specific `limited`/`opportunity` factors demoted below them, scoped to the page(s) that carry them)

### Preview / PR Audit Workflow

Use this path for PR review, local production builds, preview deployments, and branch-vs-main questions. Prefer built-in flags over manual sitemap downloads, localtunnel glue, or ad hoc URL scripts.

For a local preview server whose sitemap emits production canonicals:

```bash
npx @ainyc/aeo-audit@1 "http://localhost:3000" \
  --sitemap \
  --rewrite-sitemap-origin \
  --allow-local \
  --changed \
  --base main \
  --include-critical \
  --format agent
```

Guidance:
- Use `--allow-local` only when the user explicitly wants to audit localhost/private IPs.
- Use `--rewrite-sitemap-origin` when a local or staging sitemap emits production canonicals.
- Use `--changed --base <ref>` for PR work so unrelated site sections do not dominate the result.
- Use `--include-critical --critical-paths /,/pricing,/contact` when important pages should always be checked.
- If `--changed` finds no static routes, inspect the diff manually. Dynamic route templates cannot be safely converted to concrete URLs without route params; include known concrete paths with `--critical-paths` or audit explicit URLs separately.
- Prefer `--format agent` for agent action, `--format json` for saved compare baselines, and `--format markdown` for human summaries.

For branch-vs-production regression review, produce comparable reports first, then run `compare`:

```bash
npx @ainyc/aeo-audit@1 "https://production.example" --sitemap --format json > baseline.json
npx @ainyc/aeo-audit@1 "http://localhost:3000" --sitemap --rewrite-sitemap-origin --allow-local --format json > current.json
npx @ainyc/aeo-audit@1 compare --baseline baseline.json --current current.json --format markdown
```

Report:
- URLs audited or changed paths selected
- Score/regression verdict from `compare`
- Critical defects and prioritized fixes
- Caveats such as local/private opt-in, sitemap origin rewriting, dynamic route templates skipped, or sitemap pages filtered out

#### Machine-readable output (for agents)

Use `--format json` for the full report, or **`--format agent`** for just the decision: `{ schemaVersion, tool, mode, url, score, pass, criticalDefectCount, issues }`, where `issues` is the ranked `prioritizedFixes` and the per-factor/per-page detail is omitted. Prefer `--format agent` when you only need to decide and act. Key fields for acting on the result without parsing prose:
- `schemaVersion` (on every audit report) versions the JSON shape independently of the package version — pin to it and treat a major bump as breaking; absence means a pre-2.0 report.
- `prioritizedFixes` is a ranked array of objects, each with a stable `id`, `kind`, optional `severity`, the complete `affectedPages` list (never truncated), `affectsHomepage`, `prevalencePct`, and a human `summary`. Cross-cutting fixes also carry `avgScore`, `bestScore`/`bestPageUrl`, and a `status` (`sitewide` | `limited` | `opportunity`) — treat `limited`/`opportunity` as page-specific tune-ups, not site-wide failures. It's the pre-computed to-do list — no need to re-rank factor scores yourself.
- Stable identifiers everywhere — `criticalDefects[].id`, `prioritizedFixes[].id`, and every factor finding's `code` (e.g. `technical-seo.h1.multiple`) — let integrations key on codes rather than message strings.

#### Auxiliary File Diagnostics

When the audit fetches `/llms.txt`, `/llms-full.txt`, `/robots.txt`, and `/sitemap.xml`, it probes once with `Accept: text/markdown` to detect a **content-negotiation** trap: file responds OK to a bare request but returns a non-2xx response when the client prefers markdown. This catches Astro / Vercel / Starlight setups that 307-redirect `.txt` → non-existent `.md` for markdown-accepting clients, making the file invisible to AI content-extraction tools even though the file exists. The diagnostic surfaces as a finding on the **AI Access Files (llms.txt, sitemap)** factor.

### Local Dev / Staging Targets

By default the audit blocks any URL that resolves to a private, loopback, or link-local address (SSRF protection). When the user wants to audit **their own** dev or staging server, pass `--allow-local` (alias `--allow-private`):

```bash
npx @ainyc/aeo-audit@1 "http://localhost:3000" --allow-local --format json
npx @ainyc/aeo-audit@1 "http://10.0.5.20" --allow-private --format json
```

- Pass the explicit `http://` scheme for local dev servers — a bare host defaults to `https://`.
- The relaxation is scoped to the **single host named on the CLI**, evaluated per hop. A redirect or sitemap `<loc>` pointing at any other private host (e.g. `169.254.169.254`) stays blocked.
- To audit a whole local site whose sitemap hardcodes the prod domain, combine with sitemap origin rewriting:

```bash
npx @ainyc/aeo-audit@1 "http://localhost:3000" --sitemap --rewrite-sitemap-origin --allow-local --format json
```

### Static-Output Mode

When the user wants to audit **built HTML offline** (CI on a `next export` / `dist` / `out` directory, or before deploying), pass a filesystem path instead of a URL:

```bash
# A directory of built HTML (aggregated like sitemap mode)
npx @ainyc/aeo-audit@1 "./out" --base-url https://example.com --format json
# A single built file
npx @ainyc/aeo-audit@1 "./dist/index.html" --format json
# Gate CI on missing meta descriptions across the build
npx @ainyc/aeo-audit@1 "./out" --require-meta --format json
```

- A `.html`/`.htm` file → single-page report; a directory → aggregated report (`--limit`, `--top-issues`, `--factors`, `--include-geo`, `--include-agent-skills`, `--require-meta` apply).
- `--base-url <url>` maps files to page URLs (`out/about/index.html` → `<base>/about/`; default `https://localhost`). `index.html` collapses to its directory URL; other files drop the `.html` extension.
- `llms.txt`, `llms-full.txt`, `robots.txt`, and `sitemap.xml` are read from the directory root when present.
- **Partial coverage:** server-only signals (redirects, `X-Robots-Tag`, `Last-Modified`, `Link` headers) aren't visible from static files. Recommend auditing the deployed URL for full coverage.

### Compare / Regression Mode

When the user wants to **fail CI on an AEO regression** (a PR dropped the score, broke a page, or introduced a structural defect), use the `compare` subcommand. It diffs two saved `--format json` reports — a baseline and the current run — and exits non-zero on a regression. It runs no audit and no network; it only reads reports.

```bash
# 1. Produce the current report (any mode's --format json output works)
npx @ainyc/aeo-audit@1 "./out" --base-url https://example.com --format json > current.json
# 2. Diff against a stored baseline — exit 1 if it regressed
npx @ainyc/aeo-audit@1 compare --baseline baseline.json --current current.json
# Write a Markdown summary (for a PR comment) and tighten the overall gate
npx @ainyc/aeo-audit@1 compare --baseline baseline.json --current current.json --overall-tolerance 0 --md-out diff.md
# Committed/artifact baselines: hard-fail (exit 2) if factor set / engine major differ
npx @ainyc/aeo-audit@1 compare --baseline baseline.json --current current.json --strict-comparability
```

- **A regression is any of:** overall/aggregate drop > `--overall-tolerance` (default 2); a single page drop > `--page-tolerance` (default 5); a single factor drop > `--factor-tolerance` (default 8); a page that was auditing successfully now erroring; a new `severity:critical` defect (`--fail-on-new-critical`, default on); or a major report-schema change. Score/page/factor deltas only gate when the two runs are **comparable** (same factor set, no major engine change) — otherwise they're warnings, not failures.
- `missing-meta-description` is `severity:warning`, so it does **not** trip `--fail-on-new-critical`; use `--require-meta` on the audit or `--fail-on warnings` here. Removed pages and new warnings are report-only unless promoted with `--fail-on removed-pages,warnings`.
- **Exit codes:** `0` = no regression / improvement / first run (no baseline); `1` = regression; `2` = misconfiguration (mode mismatch, unreadable report, missing `--current`, or incomparable factor-set/engine under `--strict-comparability`). `--report-only` always exits `0` (soak mode).
- Both reports must be the same mode (two single, or two multi-page). stdout carries only the `CompareReport` JSON (or Markdown with `--format markdown`); diagnostics go to stderr.

### Lighthouse Mode

Use `--lighthouse` when the user wants page speed, accessibility, or best-practices scoring alongside the AEO factors. It calls Google PageSpeed Insights (mobile strategy) and aggregates Performance + Accessibility + Best Practices into a single optional factor (weight 8).

```bash
npx @ainyc/aeo-audit@1 "<url>" --lighthouse --format json
PAGESPEED_API_KEY=xxx npx @ainyc/aeo-audit@1 "<url>" --lighthouse --format json
```

Constraints:
- Single-URL only — cannot combine with `--sitemap` or `--detect-platform`. Each Lighthouse audit takes 15-30s, which would blow up sitemap runtime.
- Optional `PAGESPEED_API_KEY` env var lifts anonymous PSI rate limits (25k/day unauthenticated).
- On PSI failure (unreachable target, timeout, HTTP error) the factor scores 0 and surfaces a `timeout` or `unreachable` finding rather than throwing — the rest of the audit still runs.

### Detect Platform Mode

Use `--detect-platform` when the user wants to know what stack a site is built on (e.g., "is this WordPress?", "what framework does competitor X use?", "is this site custom-built?"). This is much faster than a full audit because it skips analyzer scoring.

```bash
npx @ainyc/aeo-audit@1 "<url>" --detect-platform --format json
npx @ainyc/aeo-audit@1 "<url>" --detect-platform --min-confidence high --format json
```

Flags:
- `--detect-platform` — switch to detection mode instead of auditing
- `--min-confidence <lvl>` — filter to `low` (default), `medium`, or `high` confidence
- `--urls <src>` — run on multiple URLs at once (file path, comma-separated list, or `-` for stdin)
- `--concurrency <n>` — max in-flight fetches in batch mode (default 5)

The report groups detections by category (CMS, site builder, e-commerce, framework, SSG, hosting), each with a confidence bucket, a 0–100 score, an optional version, and the signals that matched. When the report's `isCustom` flag is true, no CMS/site-builder/e-commerce platform was identified — the site is likely custom-built. Exit code is `0` when at least one platform is detected, `1` otherwise.

#### Batch detection

When the user wants to fingerprint many sites at once (competitor lists, customer cohorts), pass `--urls`:

```bash
npx @ainyc/aeo-audit@1 --detect-platform --urls urls.txt --format json
npx @ainyc/aeo-audit@1 --detect-platform --urls https://a.com,https://b.com --format json
cat urls.txt | npx @ainyc/aeo-audit@1 --detect-platform --urls - --format json
```

The batch report contains a `results` array; each entry has `status: 'success'` or `'error'`, plus the same shape as a single-URL report on success. Per-URL fetch errors do not abort the run. Exit code is `0` when at least one URL succeeded, `1` otherwise.

## Fix

Use when the user wants code changes applied after the audit.

1. Run:
   ```bash
   npx @ainyc/aeo-audit@1 "<url>" [flags] --format json
   ```
2. Find factors scoring below 70 (lowest first).
3. Apply targeted fixes in the current codebase.
4. Prioritize:
   - Structured data and schema completeness
   - `llms.txt` and `llms-full.txt`
   - `robots.txt` crawler access
   - E-E-A-T signals
   - FAQ markup
   - freshness metadata
   - agent-readiness signals: per-page Markdown source endpoints, `robots.txt` `Content-Signal` directives (the audit scores the values — set `ai-input=yes`/`search=yes` to permit AI answers and search indexing; `ai-input=no` opts out of the real-time AI use AEO depends on), and A2A agent cards (aligned with specification.website)
5. Re-run the audit and report the score delta.

Rules:
- Always explain proposed changes and get user confirmation before editing files.
- Do not remove existing schema or content unless the user asks.
- Preserve existing code style and patterns.
- If a fix is ambiguous or high-risk, explain the tradeoff before editing.

## Schema

Use when the request is specifically about JSON-LD or schema quality.

Validity issues like duplicate singleton `@type`s and JSON parse errors are **per page**, so a homepage-only audit misses every subpage. Default to sitemap mode for site-wide schema requests ("audit my schema", "are my FAQ blocks valid?"); use single-URL mode only when the user names one specific page.

Site-wide (default):

```bash
npx @ainyc/aeo-audit@1 "<url>" --sitemap --top-issues --format json --factors structured-data,schema-completeness,schema-validity,entity-consistency
```

Single page:

```bash
npx @ainyc/aeo-audit@1 "<url>" --format json --factors structured-data,schema-completeness,schema-validity,entity-consistency
```

Report:
- Schema types found
- Property completeness by type
- Missing recommended properties
- **Validity errors** (duplicate singleton `@type`s, JSON parse errors, empty `<script>` blocks) — surface these prominently regardless of overall score; Google drops invalid blocks silently from rich results
- Entity consistency issues
- In sitemap mode: list every affected URL for each validity error so the user can locate per-page duplicates

Provide corrected JSON-LD examples when useful.

Checklist:
- `LocalBusiness`: name, address, telephone, openingHours, priceRange, image, url, geo, areaServed, sameAs
- `FAQPage`: mainEntity with at least 3 Q&A pairs (and only **one** `FAQPage` block per page — duplicates invalidate rich results)
- `HowTo`: name and at least 3 steps (singleton — only one per page)
- `Organization`: name, logo, contactPoint, sameAs, foundingDate, url, description
- Singletons that must not repeat per page: `FAQPage`, `HowTo`, `Article`, `BlogPosting`, `NewsArticle`, `BreadcrumbList`, `Product`, `Recipe`

## llms.txt

Use when the user wants `llms.txt` or `llms-full.txt` created or improved.

If a URL is provided:
1. Run:
   ```bash
   npx @ainyc/aeo-audit@1 "<url>" [flags] --format json --factors ai-access-files
   ```
2. Inspect existing AI-readable files if present.
3. Extract key content from the site.
4. Generate improved `llms.txt` and `llms-full.txt`.

If no URL is provided:
1. Inspect the current project.
2. Extract business name, services, FAQs, contact info, and metadata.
3. Generate both files from local sources.

After generation:
- Add `<link rel="alternate" type="text/markdown" href="/llms.txt">` when appropriate.
- Expose per-page Markdown source endpoints (a `.md` URL or content negotiation) advertised via `<link rel="alternate" type="text/markdown">` — a scored AI-readable signal.
- Suggest adding the files to the sitemap.

## Monitor

Use when the user wants progress tracking or a competitor comparison.

Single URL:
1. Run the audit.
2. Compare against prior results in `.aeo-audit-history/` if present.
3. Show overall and per-factor deltas.
4. Save the current result.

Comparison mode:
1. For branch-vs-production, produce baseline and current `--format json` reports in the same mode, then run the `compare` subcommand.
2. For competitor benchmarking, audit both public URLs and show side-by-side factor deltas.
3. Highlight advantages, weaknesses, regressions, and priority gaps.

## Behavior

- If the task needs a deployed site and no URL is provided, ask for the URL.
- If the task is diagnosis only, do not edit files.
- If the task is a fix request, make edits and verify with a rerun when possible.
- If the URL is unreachable or not HTML, report the exact failure.
- If a local/private URL is requested and `--allow-local` is missing, rerun with `--allow-local` only after confirming local preview auditing is intended.
- If sitemap mode appears to audit production during preview work, rerun with `--rewrite-sitemap-origin`.
- Prefer concise, evidence-based recommendations over generic SEO advice.
