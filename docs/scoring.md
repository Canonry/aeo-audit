# Scoring

## Why AEO?

AI answer engines are replacing traditional search for millions of queries. Getting cited by ChatGPT or Perplexity requires different signals than ranking in Google:

- **Structured data** (JSON-LD) with FAQPage schema shows 2.7x higher citation rates
- **llms.txt** files help AI systems understand your site at a glance
- **E-E-A-T signals** (author credentials, trust pages) determine citation trustworthiness
- **Content extractability**: clean, well-structured content gets cited; paywalled content doesn't

## The 16 scoring factors

| Factor | Weight | What It Checks |
|--------|--------|---------------|
| Structured Data (JSON-LD) | 12% | Presence of LocalBusiness, FAQPage, Service, HowTo schemas |
| Content Depth | 10% | Word count, heading hierarchy, paragraph structure, lists |
| AI Access Files (llms.txt, sitemap) | 5% | llms.txt, llms-full.txt, robots.txt, sitemap.xml availability, per-page Markdown source endpoints |
| E-E-A-T Signals | 8% | Author meta, Person schema credentials, trust pages, reviews |
| FAQ Content | 8% | FAQPage schema, details/summary blocks, question-style headings |
| Citations & Authority | 8% | External links, authoritative domains, sameAs references |
| Schema Completeness | 8% | Property depth per schema type vs recommended properties |
| Entity Consistency | 7% | Name consistency across schema, title, og:title; contact alignment |
| Content Freshness | 7% | dateModified, Last-Modified header, sitemap lastmod, copyright year |
| Content Extractability | 6% | Content-to-boilerplate ratio, citation-ready blocks, paywall detection |
| Definition Blocks | 6% | "What is", "How to" headings, step lists, HowTo schema, dl elements |
| Named Entities | 6% | Brand mentions, knowsAbout/founder signals, proper noun density |
| Snippet Eligibility | 6% | `noindex`/`nosnippet`/`max-snippet` directives in meta robots and `X-Robots-Tag`. Google ties AI feature eligibility to these ([source][google-aeo]) |
| Technical SEO | 5% | H1 presence, image alt text, meta description length, canonical tag |
| Schema Validity | 5% | Duplicate singleton @types, JSON parse errors, empty JSON-LD blocks |
| AI Crawler Access | 4% | Per-bot robots.txt rules for GPTBot, ClaudeBot, PerplexityBot, etc., plus Content Signals directives |

Weights sum to 100% for the active factors. Pass `--factors <list>` to run a subset (see the [CLI reference](cli.md#running-a-subset-of-factors)).

## Optional factors

These are excluded by default; when included, the weights renormalize.

- **Geographic Signals (7%)**: LocalBusiness geo data, address, areaServed. Enable with `--include-geo`.
- **Agent Skill Exposure (6%)**: Schema.org Action, MCP, A2A agent cards, form affordances. Enable with `--include-agent-skills`.
- **Lighthouse (8%)**: Performance, Accessibility, and Best Practices scores via Google PageSpeed Insights (mobile strategy). Enable with `--lighthouse`. Adds ~15-30s per audit; set `PAGESPEED_API_KEY` to lift anonymous rate limits.

[google-aeo]: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide "Google: AI features and your website"

> **Note on Google's guidance.** Google's [AI features and your website][google-aeo] guide says `llms.txt` and heavy structured data aren't required for AI Overviews or AI Mode. We still score them: Google is one engine; ChatGPT, Perplexity, and Claude do rely on them. Snippet eligibility is the one hard gate Google enforces: a page must be indexable and snippet-eligible to appear in AI features.

## Score bands

The audit emits a **0–100 score** for every factor and a weighted **overall score** (0–100) — there are no letter grades or pass/partial/fail labels. Threshold the raw score to whatever bands suit your use. For reference, the CLI's own conventions:

| Score | Meaning |
|-------|---------|
| 70–100 | Strong — meets the CLI's pass gate |
| 40–69 | Moderate — clear gaps remain |
| 0–39 | Weak — major work needed |

The CLI exits `0` for an overall score ≥ 70 and `1` below; see [Exit codes](cli.md#exit-codes).

## Sitemap aggregation: cross-cutting issues and page-specific factors

A sitemap (or static) run averages each factor across every audited page into `crossCuttingIssues[]`, and the worst of those plus the per-page critical defects become the ranked `prioritizedFixes[]`. Two refinements keep that rollup honest:

**Best-page context on every factor.** Each cross-cutting issue carries `bestScore` and `bestPageUrl` — the single highest-scoring page for that factor (homepage wins ties). A site-wide gap then reads as *"Structured Data is 100 on the homepage — propagate that template to the 393 other pages"* rather than a bare *"add schema"*.

**Two averages, because there are two questions.** A factor that only some page types can satisfy has a structurally low site-wide mean: an FAQ living on 8 of 500 pages averages ~1/100, which is arithmetically correct and describes a site that doesn't exist. Every cross-cutting issue therefore carries both:

| Field | Denominator | Answers |
|-------|-------------|---------|
| `avgScore` | every audited page | How much of the site has this? |
| `applicableAvgScore` | pages the factor applies to (`applicablePages`) | How good is it where it exists? |

`affectedPages` / `applicableAffectedPages` split the same way. Reports show the applicable figure; `avgScore` keeps its original meaning and value so existing consumers are unaffected.

**How applicability is decided.** An analyzer that can tell reports it directly by returning `applicable` (FAQ Content and Definition Blocks do, from schema, URL, title, and page structure). For any analyzer that stays silent, a factor expected site-wide always applies, and a page-specific one applies where it is present (score ≥ 30) — the pre-existing rule, so silence preserves the old behavior exactly.

**Page-specific factors aren't site-wide failures.** Some factors legitimately apply to only certain page types — a product or portfolio page has no business carrying an **FAQ** or a glossary **Definition Block**, so a 0 there is correct, not a gap. Averaged across a whole site, these score near 0 and "affect" almost every page, which would otherwise float them to the top of the fix list and read as *"Critical: build an FAQ"* even when the site already has a good one on `/faq`. Each cross-cutting issue therefore carries a `status`:

| `status` | Meaning | Ranking |
|----------|---------|---------|
| `sitewide` | Expected on every page (schema, E-E-A-T, freshness, citations…); a low average is a real coverage gap. | By prevalence, as before. |
| `limited` | A page-specific factor **present on at least one page** (best score ≥ 30) but isolated. A tune-up/extend, not build-from-scratch. | Demoted below all `sitewide` issues. |
| `opportunity` | A page-specific factor **not yet present on any audited page**. Adding it is discretionary. | Demoted, with no pages marked "affected". |

For a `limited` factor the fix is scoped to the page(s) that actually carry it and the recommendation is the tune-up from there (*"add question-style headings to `/faq`"*) — never the "add it everywhere" recommendation aggregated from pages that correctly lack it. Presence (best ≥ 30), **not** coverage breadth, is the gate: thin coverage is the expected state for these factors and never downgrades a `limited` to a worse label. The page-specific set is currently **FAQ Content** and **Definition Blocks** (`PAGE_SPECIFIC_FACTOR_IDS`, exported from `@ainyc/aeo-audit/scoring`).
