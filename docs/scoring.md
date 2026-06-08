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
| AI-Readable Content | 5% | llms.txt, llms-full.txt, robots.txt, sitemap.xml availability, per-page Markdown source endpoints |
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
