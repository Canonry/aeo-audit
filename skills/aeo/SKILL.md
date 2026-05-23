---
name: aeo
description: Run AEO audits, fix site issues, validate schema, generate llms.txt, and compare sites.
homepage: https://ainyc.ai
repository: https://github.com/AINYC/aeo-audit
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

One skill for audit, fixes, schema, llms.txt, and monitoring workflows.

## Command

Always use the published package:

```bash
npx @ainyc/aeo-audit@1 "<url>" [flags] --format json
```

## Argument Safety

**Never interpolate user input directly into shell commands.** Always:
1. Validate that URLs match `https://` or `http://` and contain no shell metacharacters.
2. Quote every argument individually (e.g., `npx @ainyc/aeo-audit@1 "https://example.com" --format json`).
3. Pass flags as separate, literal tokens — never construct command strings from raw user text.
4. Reject arguments containing characters like `;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `<`, `>`, or newlines.

## Modes

- `audit`: grade and diagnose a site
- `fix`: apply code changes after an audit
- `schema`: validate JSON-LD and entity consistency
- `llms`: create or improve `llms.txt` and `llms-full.txt`
- `monitor`: compare changes over time or benchmark competitors
- `detect-platform`: identify the CMS, site builder, framework, or hosting stack a site uses

If no mode is provided, default to `audit`.

## Examples

- `audit https://example.com`
- `audit https://example.com --sitemap`
- `audit https://example.com --sitemap --limit 10`
- `audit https://example.com --sitemap --top-issues`
- `audit https://example.com --lighthouse`
- `fix https://example.com`
- `schema https://example.com`
- `llms https://example.com`
- `monitor https://site-a.com --compare https://site-b.com`
- `detect-platform https://example.com`
- `detect-platform https://example.com --min-confidence high`
- `detect-platform --urls competitors.txt`
- `detect-platform --urls https://a.com,https://b.com`

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
   - Overall grade and score
   - Short summary
   - Factor breakdown
   - Top strengths
   - Top fixes
   - Metadata such as fetch time and auxiliary file availability

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
- `--top-issues` — skip per-page output, show only cross-cutting patterns

Pages are audited with bounded concurrency (5 in flight) to avoid hammering the target origin.

Returns:
- Per-page scores and grades
- Cross-cutting issues (factors failing across multiple pages)
- Aggregate score and grade
- Prioritized fixes ranked by site-wide impact

#### Auxiliary File Diagnostics

When the audit fetches `/llms.txt`, `/llms-full.txt`, `/robots.txt`, and `/sitemap.xml`, it probes once with `Accept: text/markdown` to detect a **content-negotiation** trap: file responds OK to a bare request but returns a non-2xx response when the client prefers markdown. This catches Astro / Vercel / Starlight setups that 307-redirect `.txt` → non-existent `.md` for markdown-accepting clients, making the file invisible to AI content-extraction tools even though the file exists. The diagnostic surfaces as a finding on the **AI-Readable Content** factor.

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
2. Find factors with status `partial` or `fail`.
3. Apply targeted fixes in the current codebase.
4. Prioritize:
   - Structured data and schema completeness
   - `llms.txt` and `llms-full.txt`
   - `robots.txt` crawler access
   - E-E-A-T signals
   - FAQ markup
   - freshness metadata
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
   npx @ainyc/aeo-audit@1 "<url>" [flags] --format json --factors ai-readable-content
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
- Suggest adding the files to the sitemap.

## Monitor

Use when the user wants progress tracking or a competitor comparison.

Single URL:
1. Run the audit.
2. Compare against prior results in `.aeo-audit-history/` if present.
3. Show overall and per-factor deltas.
4. Save the current result.

Comparison mode:
1. Parse `--compare <url2>`.
2. Audit both URLs.
3. Show side-by-side factor deltas.
4. Highlight advantages, weaknesses, and priority gaps.

## Behavior

- If the task needs a deployed site and no URL is provided, ask for the URL.
- If the task is diagnosis only, do not edit files.
- If the task is a fix request, make edits and verify with a rerun when possible.
- If the URL is unreachable or not HTML, report the exact failure.
- Prefer concise, evidence-based recommendations over generic SEO advice.
