# Changelog

## 4.6.2 (2026-08-09)

### Changed

- **Preferred Canonry package with Ainyc compatibility.** `@canonry/aeo-audit` is now the documented and runtime-facing package. The release workflow publishes `@ainyc/aeo-audit` at the same version as a normal compatibility package, so existing consumers keep their install path.
- **One build, two verified package identities.** The release workflow pins npm 11.5.1 before packaging, creates the Canonry artifact once, derives the Ainyc artifact by changing only its package name, verifies matching versions and semantic package parity, then publishes Canonry first.
- **Trusted-publisher bootstrap posture.** The release sequence establishes `@canonry/aeo-audit@0.0.0-bootstrap.0` to configure npm Trusted Publishing before the first stable Canonry release; `4.6.2` replaces npm's temporary initial `latest` tag. Each public scope trusts this repository workflow, and retry checks fail closed unless npm returns a valid matching SHA-512 integrity value.

## 4.6.1 (2026-08-09)

### Changed

- **Canonical public package restored.** The engine again publishes as `@ainyc/aeo-audit`, preserving the existing public install path while adding the 4.3–4.6 hosted-engine and crawl capabilities.
- **One validated artifact per release.** The release workflow validates and packs once, then publishes that tarball to npm before publishing the matching ClawHub skill version.

## 4.6.0 (2026-08-08)

### Added

- **Bounded full-site crawl.** `runSiteCrawl` discovers URLs from the root, recursive sitemaps, `robots.txt`, and internal HTML links.
- **Typed page graph.** Results include page state, indexability reasons, canonical and redirect edges, crawl depth, link counts, and link score.
- **Checkpoint events.** The engine emits bounded page, edge, progress, metric, and summary batches with stable IDs and checksums.
- **Optional dead-link findings.** `checkDeadLinks` defaults to false. The engine uses observed internal targets and never probes external links.
- **Request pacing.** `requestDelayMs` spaces every outbound request start, including redirect hops. Valid robots `Crawl-delay` directives raise the effective delay when robots behavior is enabled; pacing remains abortable and bounded by `maxDurationMs`.

### Changed

- **Shared HTML analysis.** Network, static, sitemap, and full-crawl paths now use the same analyzer function without an import cycle.
- **Redirect boundary.** Host-scoped crawls record external redirects but do not fetch the external target. A root redirect outside the exact host now returns an explicit partial result instead of a misleading complete crawl.
- **Versioned crawl semantics.** The crawl schema is `1.1`, the engine version is `1.1.0`, and URL normalization is `1.1.0` after narrowing automatic query stripping to unambiguous analytics and click identifiers.

### Fixed

- Redirect-terminal page admission is deterministic at the page-cap boundary, regardless of concurrent response order.
- HTTP error and explicit non-HTML bodies are cancelled, and ambiguous non-HTML bodies are rejected after the initial sniff instead of being downloaded to the byte cap.
- Crawl depth uses a prebuilt adjacency index instead of rescanning every edge for every page.
- Semantic `ref`, `source`, and `campaign` query parameters are preserved.
- Sitemap page and child locations share numeric and named XML entity decoding.
- Analyzer failures remain attached to the fetched HTML observation through its `error` field.

## 4.5.0 (2026-08-05)

### Added
- **Stratified crawl selection replaces the sitemap prefix.** `eligible.slice(0, limit)` took pages in sitemap document order — and because most sitemaps declare no `<priority>`, the priority sort ahead of it was a no-op on tied values, making the slice pure list order. On a templated site that handed one section 16 pages and the next 1 for no reason but how the URLs sorted, and every rollup downstream inherited the skew. Crawls now infer each URL's template from the corpus (identifier segments collapse to `*`) and round-robin the page budget across templates, largest first, with the homepage pinned and `<priority>` deciding which instances of a template get picked. Selection is a pure function of the URL list, so two runs over one sitemap choose the same pages and `compare` still works. Applies to sitemap and static-directory mode alike. **The first run after upgrading audits a different page set than an existing baseline, which makes that baseline non-comparable** — `compareMeta.engineVersion` records the change.
- **`coverage` on every multi-page report.** `aggregateScore: 48` over 6% of a site read as a site score. Reports now carry `pagesAudited` / `pagesDiscovered` / `coveragePct`, whether the run `sampled`, `templatesDiscovered` / `templatesRepresented`, and a `confidence` of `full` | `representative` | `indicative`. Confidence keys on template reach rather than raw percentage: a 5% sample touching every URL shape generalizes; a 45% prefix that never left one section does not, and is labelled `indicative` with a note naming the templates it missed. The score itself is computed exactly as before, so exit codes and CI gates are unchanged.
- **`templateGroups`: one template, N instances.** Pages that share a URL shape *and* score alike are collapsed into the template that produced them. Reporting "492 pages failing" implies 492 pieces of work when it is one change; every fix now also carries `templateCount` / `instanceCount` and reads "1 template · 194 pages". Both signals must agree — score alone would merge 194 unrelated pages that happen to be equally bad, and URL shape alone would merge a route whose instances genuinely differ. A 2-point per-factor tolerance absorbs boundary noise so one property description crossing a word-count bucket doesn't split a template in two. Grouping is an overlay: per-page results stay complete and no URL is dropped from `affectedPages`.
- **`applicable` on the analyzer contract.** An analyzer that can tell whether a page was ever meant to satisfy its factor may now say so. FAQ Content and Definition Blocks report it from schema, URL, title, and page structure; every other analyzer is untouched and behaves exactly as before.

### Changed
- **Page-specific factors are no longer averaged over pages they don't apply to.** An FAQ on 8 of 500 pages produced `avgScore: 1, affectedPages: 500, affectedPct: 100` — a factor score that asserts every page on the site has an FAQ problem when 492 of them aren't FAQ pages, and one that could not go in a client deliverable. Cross-cutting issues now also carry `applicablePages`, `applicableAvgScore`, and `applicableAffectedPages`, computed over the pages the factor applies to; `PrioritizedFix` carries `applicableAvgScore` / `applicablePages`, and a `limited` fix's `prevalencePct` is scoped to that denominator instead of the whole site. Text and Markdown reports show the applicable figure. **`avgScore`, `affectedPages`, and `totalPages` keep their original meaning and values**, so existing consumers see no change — including Canonry's `computeFactorAverages`, which needs its own update to read the new fields.
- **`schemaVersion` bumped `3.3` → `3.4`** (additive: `coverage`, `templateGroups`, the `applicable*` fields on cross-cutting issues, and `templateCount` / `instanceCount` / `applicable*` on prioritized fixes). No existing field changed shape, and the only semantic change is the one noted above — a `limited` fix's `prevalencePct` is now scoped to `applicablePages` rather than the whole site.

### Fixed
- **Schema recommendations no longer name a type the evidence can't support.** An apartment operator was told to add `SoftwareApplication` schema — the kind of instruction a developer implements literally across 194 property pages. The cause was misdetection, not a hardcoded string: a jsdelivr/unpkg/cdnjs reference awarded a point toward "developer tool" (a fact about how a page loads assets, true of most of the web), a GitHub link awarded another, `pricing` and `enterprise` sat in the SaaS keyword list, and the local-business list was almost entirely restaurant phrasing, so a premises-based business scored near zero there. The CDN signal is removed outright, the GitHub link now only counts once the page text already reads developer-shaped, local-business keywords cover non-hospitality premises, and a `real-estate` category was added (`ApartmentComplex` / `Residence` / `RealEstateListing`). A nested `PostalAddress` — present in almost every address graph, including inside an `ApartmentComplex` node — no longer counts as a local-business signal, since it had been tying the real-estate score on the very property pages the category exists for and collapsing the pick back to generic advice. A specific type is only named when the runner-up category isn't close; otherwise the advice stays generic and asks for the type matching the site's primary entity. New finding code `structured-data.site-category.detected` records the classification and the signals behind it, so a wrong call is diagnosable from the report.

## 4.3.0 (2026-07-16)

### Added
- **Private GitHub Packages engine package.** The package now publishes as `@canonry/aeo-audit@4.3.0` to `https://npm.pkg.github.com` via `publishConfig`, with a committed scope-only `.npmrc` (`@canonry:registry=https://npm.pkg.github.com`) and no committed auth token.
- **Hosted engine contract from the package root.** Root exports now include the typed `AeoAuditErrorCode` union, `AeoAuditError`, `isAeoAuditError`, `isAeoAuditErrorCode`, `getAeoAuditErrorCode`, `runAeoAudit`, `runSitemapAudit`, `engineVersion`, abort-aware options, outbound-attempt observer types, and typed sitemap partial/budget metadata.
- **Abort and budget controls for hosted sitemap audits.** `runAeoAudit` and `runSitemapAudit` accept `AbortSignal`; sitemap mode adds cumulative `maxFetches` and `maxDurationMs` budgets. When a sitemap audit stops after discovery because a budget is exhausted, the returned `SitemapAuditReport.metadata` marks the report partial and records fetch count, elapsed time, queued/completed/remaining pages, and the budget stop reason.

### Changed
- **`schemaVersion` bumped `3.1` → `3.2`** (additive: `SitemapAuditReport.metadata` for partial/budgeted reports). Existing report fields are unchanged.
- **Release workflow publishes to GitHub Packages with `GITHUB_TOKEN`.** The publish job now uses `permissions: contents: read, packages: write`, configures Node for `https://npm.pkg.github.com`, sets `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, and runs `npm publish` against GitHub Packages. It is manually dispatched so downstream consumers can receive package read access and dependency/authentication PRs before production publication.
- **ClawHub skill publishing remains part of the release.** The workflow still publishes `skills/aeo` to ClawHub with the release changelog so the documented `/aeo` skill path stays current.
- **Consumer migration is documented.** `docs/private-github-packages.md` records the required `.npmrc`, `packages: read`, token, and compatibility gate for private-package consumers. Existing `@ainyc/aeo-audit` consumers must not lose access before they migrate.

### Fixed
- **Sitemap discovery cancellation preserves the caller's abort reason.** Caller aborts during `/sitemap.xml`, `/sitemap-index.xml`, or `robots.txt` discovery now escape as the original abort reason instead of being swallowed and rewrapped as a generic unreachable sitemap failure.
- **DNS rebinding regression coverage.** Added coverage for a host that resolves public during preflight and private at connect time, proving the private endpoint is never contacted.

## 4.2.0 (2026-06-27)

### Changed
- **Content Signals Policy: score the values, not mere presence (scoring change).** The `ai-crawler-access` factor used to award a flat +8 for *any* `Content-Signal:` line in `robots.txt`, so a site declaring `ai-input=no` — which asks answer engines not to use the page for AI answers (RAG/grounding) — was rewarded for opting out of AEO. The audit now parses the per-`User-agent` Content Signals directive (Cloudflare / [contentsignals.org](https://contentsignals.org)) and scores each signal by its value: `ai-input=yes` and `search=yes` are credited (+6 / +2), `ai-input=no` and `search=no` are penalized and flagged with a fix recommendation, and `ai-train=no` is neutral for citation (it blocks training, not answers, and is Cloudflare's own default). The ideal `search=yes, ai-input=yes` policy still nets +8, so AEO-friendly sites are unaffected; only sites that declare restrictive or partial signals see a score change. New finding codes: `ai-crawler-access.content-signal.{ai-input-allowed,ai-input-blocked,search-allowed,search-blocked,ai-train-blocked}`. No CLI or output-format change.

## 4.1.3 (2026-06-24)

### Fixed
- **SSRF: pin the validated IP to close a DNS-rebinding TOCTOU (security).** The guard resolved the host and checked its IPs, then handed the hostname to `fetch()`, which re-resolved at connect time — so a low-TTL record could answer public during validation and a private IP (`127.0.0.1`, `169.254.169.254`) at connect, on any redirect hop. Outbound requests now go through an `undici` dispatcher whose connect-time DNS lookup returns **only** public IPs and connects to exactly that address, so the IP validated is the IP connected to; the hostname is still used for TLS SNI and the `Host` header, so HTTPS certificate validation is unchanged. `--allow-local` keeps using the default resolver for the single host you named. Adds `undici` as a dependency. No CLI, output, or scoring change.

## 4.1.2 (2026-06-24)

### Fixed
- **SSRF: sitemap mode now validates every outbound fetch (security).** In `--sitemap` mode the runner fetched the sitemap, `robots.txt`, and — critically — every sitemap-index child `<loc>` through a raw `fetch()` with no SSRF guard and auto-follow redirects. A malicious or compromised target could therefore steer the auditing host onto internal endpoints: a public `/sitemap.xml` that `302`s to `http://169.254.169.254/…`, a sitemap index listing `<loc>http://169.254.169.254/…</loc>`, or an internal host passed directly via `--sitemap`/the audited origin all reached cloud-metadata and internal services (the single-URL path was already guarded; only the sitemap fetches were exposed). Every sitemap/robots/child-`<loc>` fetch now routes through the same `fetchWithValidatedRedirects` guard used by the page fetch — hostname blocklist + DNS→private-IP rejection re-checked on **every** redirect hop, with redirects followed manually. `--allow-local` continues to permit only the single host you named (host-only, per-hop), so a redirect or `<loc>` to any *other* private host stays blocked. No CLI, output, or scoring change.
- **DoS: bounded sitemap-index child fan-out.** A sitemap index was fetched with `Promise.all` over *every* child `<loc>`, so a malicious or misconfigured index listing tens of thousands of children fired that many simultaneous fetches on the shared runner (the `--limit` slice only applies afterward). Child sitemaps are now fetched with the same bounded concurrency (5) as page audits and capped at the first 1000 per index; when the cap drops children the CLI prints a notice. No CLI, output, or scoring change.

## 4.1.1 (2026-06-20)

### Fixed
- **AEO Audit Guard action: robust engine-version resolution.** The composite action resolved the engine version with `npm view "@ainyc/aeo-audit@<major>" version | tail -n1`, which returns a `pkg@x 'x'` line — not a bare version — once the `@<major>` range matches multiple published versions, producing a malformed `npx` spec and an empty report. It now uses `npm view … --json | sort -V | tail -n1` to take the highest clean semver. The README's GitHub Action example now points at the standalone `Canonry/aeo-audit-action@v4` (also published to the GitHub Marketplace).

## 4.1.0 (2026-06-19)

### Added
- **`aeo-audit compare` subcommand — a regression gate.** Diffs two `--format json` reports (a baseline and a current run) into a typed `CompareReport` and a CI-friendly exit code (`0` no regression / improvement / no-baseline, `1` regression, `2` misconfiguration). A regression is any of: overall/aggregate drop > `--overall-tolerance` (default 2), a single page drop > `--page-tolerance` (default 5), a single factor drop > `--factor-tolerance` (default 8), a page that was auditing successfully now erroring out (caught even though `aggregateScore` averages success pages only and would otherwise hide it), a new `severity:critical` defect (`--fail-on-new-critical`, default on), or a major report-schema change. Score/page/factor deltas only gate when the two runs are **comparable** (same factor set, no major engine change); otherwise they're reported with a warning. New-critical detection distinguishes a genuinely new defect type / a previously-clean page regressing (both gate) from a known templated defect arriving on a net-new page (report-only). `--fail-on removed-pages,warnings` promotes report-only dimensions; `--report-only` never fails; `--strict-comparability` turns a factor-set / engine-major mismatch into a hard exit-2 for committed/artifact baselines. Exported as `compareReports`, `renderCompareMarkdown`, `isSitemapReport`, `driftLevel`, and `DEFAULT_COMPARE_POLICY` from `@ainyc/aeo-audit` and the new `@ainyc/aeo-audit/compare` subpath.
- **`compareMeta` on reports.** `AuditReport` and `SitemapAuditReport` now carry an optional `compareMeta` (`engineVersion`, `factorIds`) so a stored baseline records which engine and factor set produced it — scoring changes can ship under a package version that does not bump `schemaVersion`, so `compare` uses the engine version to judge comparability. `engineVersion()` is exported.

### Changed
- **`schemaVersion` bumped `3.0` → `3.1`** (additive: the optional `compareMeta` field). Existing fields are unchanged; parsers pinned to `3.0` keep working, and `compare` treats a `3.0` baseline vs a `3.1` current as a non-gating minor drift.

## 4.0.1 (2026-06-17)

### Fixed
- **Sitemap `<loc>` URLs are now XML-entity-decoded (issue #50).** Per the [sitemaps.org spec](https://www.sitemaps.org/protocol.html#escaping), a `&` inside a URL must be written `&amp;`, so any spec-compliant `<loc>` with a multi-param query string (`?type=pages&amp;page=1`) arrives entity-escaped. `parseSitemapXml` previously passed the literal `...&amp;...` to the fetcher, which the origin treats as a different (usually empty) request. On a **sitemap index** — where every child `<loc>` carries query params (BigCommerce, many paginated CMS sitemaps) — every child fetch failed and the audit aborted with `BAD_INPUT: No auditable URLs found in sitemap.`; on a flat `<urlset>` the affected pages were silently dropped. Both the `urlset` and `sitemapindex` branches now decode the five predefined XML entities plus decimal/hex numeric character references (with `&amp;` resolved last). No API or scoring change.

## 4.0.0 (2026-06-09)

### Breaking
- **Renamed the `ai-readable-content` factor to `ai-access-files` ("AI Access Files (llms.txt, sitemap)").** The factor that scores root-level AI access files (`/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap.xml`, and per-page Markdown source endpoints) now uses the id `ai-access-files` and the display name **AI Access Files (llms.txt, sitemap)**. Breaking for anything keyed on the old identifier:
  - `--factors ai-readable-content` is now **`--factors ai-access-files`**.
  - All 20 finding codes are renamed from `ai-readable-content.*` to `ai-access-files.*` (e.g. `ai-readable-content.llms-txt.strong` → `ai-access-files.llms-txt.strong`). Full registry in [docs/finding-codes.md](docs/finding-codes.md).
  - The analyzer export is renamed `analyzeAiReadableContent` → **`analyzeAiAccessFiles`** (subpath `@ainyc/aeo-audit/analyzers/ai-readable-content` → `…/ai-access-files`), and the `FACTOR_SPEC_RULES` key changes to match.
  - Scores and the 5% weight are unchanged, and the report JSON **shape** is identical — but `schemaVersion` is bumped **`2.1` → `3.0`** to flag the breaking identifier rename, so agent parsers pinned to the old factor id or finding codes detect the drift via the major bump (per the documented "treat a major bump as breaking" contract).

## 3.1.0 (2026-06-09)

### Added
- **Best-page context on every cross-cutting factor.** `CrossCuttingIssue` and cross-cutting `PrioritizedFix` entries now carry `bestScore` and `bestPageUrl` — the single strongest page for that factor (homepage wins ties). A site-wide gap reads as "Structured Data is 100 on the homepage — propagate that template to the rest" instead of a bare "add schema". The `avgScore` is unchanged; it stays an honest whole-site coverage number.
- **Page-specific factor classification.** Cross-cutting issues carry a `status`: `sitewide`, `limited`, or `opportunity`. Factors that legitimately apply to only some page types (**FAQ Content**, **Definition Blocks** — exported as `PAGE_SPECIFIC_FACTOR_IDS` from `@ainyc/aeo-audit/scoring`) no longer float to the top of `prioritizedFixes` and read as "Critical: build an FAQ" when the site already has one. A page-specific factor present on at least one page (best score ≥ 30) is `limited` (a tune-up, demoted below genuine site-wide gaps, scoped to the page(s) that carry it with the tune-up recommendation from there); one absent everywhere is an `opportunity` (optional, no pages marked affected). Presence — not coverage breadth — is the gate. See [docs/scoring.md](docs/scoring.md#sitemap-aggregation-cross-cutting-issues-and-page-specific-factors).

### Changed
- **`schemaVersion` bumped to `2.1`** (additive: `CrossCuttingIssue` gained `pageSpecific`, `status`, `bestScore`, `bestPageUrl`; `PrioritizedFix` gained optional `status`, `bestScore`, `bestPageUrl`). Existing fields are unchanged; parsers pinned to `2.0` keep working.
- Sitemap text and markdown reports show the `status` label and best-page alongside each factor's average; the markdown Cross-Cutting table gains **Status** and **Best (page)** columns. Page-specific factors render their concise status line instead of an "add it to every page" per-page dump (the same false positives that demotion removes); their real, scoped fix appears in Prioritized Fixes. Site-wide factors are unchanged and still list every affected page in full.

## 3.0.0 (2026-06-08)

### Breaking
- **Letter grades removed — the audit is now a pure 0–100 score.** The `grade`-family fields are gone from the JSON: `AuditReport.overallGrade`, `SitemapAuditReport.aggregateGrade`, `SitemapPageResult.overallGrade`, `ScoredFactor.grade`, `CrossCuttingIssue.avgGrade`, and `AgentSummary.grade` (so `--format agent` now emits `{ schemaVersion, tool, mode, url, score, pass, criticalDefectCount, issues }`). `PrioritizedFix.avgGrade` (a letter) is replaced by **`PrioritizedFix.avgScore`** (a 0–100 number, cross-cutting fixes only). The `scoreToGrade()` export is removed from `@ainyc/aeo-audit/scoring`. Migrate by reading the 0–100 `overallScore` / `aggregateScore` / per-factor `score` / `avgScore` and thresholding to your own bands.
- **Per-factor `status` band removed.** `ScoredFactor.status` (`'pass' | 'partial' | 'fail'`) and the `scoreToStatus()` export are gone. `ScoredFactor` is now structurally identical to `RawFactorResult` (`id, name, weight, score, findings, recommendations`). Derive any banding from `score` directly. (`SitemapPageResult.status` — `'success' | 'error'` — is unrelated and unchanged, as is the `AgentSummary.pass` ≥ 70 gate and all CLI exit codes.)
- **`schemaVersion` bumped to `2.0`** to mark the removed fields. Parsers pinned to `1.x` should expect `grade`/`status` to be absent.

### Changed
- The single-page report `summary` now reads `Overall score <N>/100. …` instead of `Overall grade <letter>. …`. Text and markdown reports show the numeric score (and a score-derived color/icon) wherever a letter grade previously appeared; the markdown factor table drops its `Grade` and `Status` columns, and the per-page table drops `Grade` (keeping the `success`/`error` `Status`).

## 2.1.0 (2026-06-03)

### Added
- **Stable finding codes.** Every `AuditFinding` now carries a `code` namespaced as `<factor-id>.<check>[.<variant>]` (e.g. `technical-seo.h1.multiple`, `schema-validity.singleton.duplicate`), so agents and integrations key on a stable machine identifier instead of regex-matching the human `message` (which can change between releases). 212 codes across all 19 analyzers; the full registry is in [docs/finding-codes.md](docs/finding-codes.md). Codes follow a documented convention and are unique across the tool (enforced by a test). `AuditFinding.code` is required, so the compiler guarantees no finding ships without one.
- `hasMissingMetaDescription` (the `--require-meta` gate) now keys on `technical-seo.meta-description.missing` rather than a message prefix — the first consumer migrated to codes.

### Changed
- **`schemaVersion` bumped to `1.1`** (additive: findings gained the `code` field). Report shapes are otherwise unchanged.

## 2.0.0 (2026-06-03)

### Breaking
- **`SitemapAuditReport.prioritizedFixes` is now a structured `PrioritizedFix[]`, not `string[]`.** Each entry is a typed object — `{ kind, id, title, recommendation, severity?, affectedPages, affectsHomepage, prevalencePct, avgGrade?, summary }` — so an AI agent can act on the ranked to-do list without regex-parsing prose. The human-readable one-liner is preserved on `.summary`; migrate by reading `prioritizedFixes.map(f => f.summary)`. The text/markdown reports are unchanged in spirit (they render the structured fixes, now spelling out every affected page).
- **New `schemaVersion` field on `AuditReport` and `SitemapAuditReport`** (exported `SCHEMA_VERSION`, currently `"1.0"`). It versions the report's JSON shape independently of the npm package version so agent parsers can detect breaking drift instead of failing silently. Treat the absence of the field as "pre-2.0 / legacy shape."

### Added
- **`--format agent` — a slim, agent-native decision output.** Returns `{ schemaVersion, tool, mode, url, score, grade, pass, criticalDefectCount, issues }` as JSON, where `issues` is the ranked `PrioritizedFix[]`, omitting the per-factor and per-page detail an agent would otherwise have to average and re-rank. Works for single-URL, sitemap, and static-output audits (single-page reuses the same critical-defect and cross-cutting aggregation over a one-page "site"); `--detect-platform` falls back to structured JSON. New `agentSummaryFromAudit()` / `agentSummaryFromSitemap()` exports, `AgentSummary` type, and `formatAgent` / `formatSitemapAgent` formatters.
- **Critical per-page defects surfaced by impact, not prevalence (#42).** Sitemap and static-directory reports now include a `criticalDefects` rollup and a **Critical Defects** section (text + markdown) that lists binary, one-line-fix structural defects — an `<h1>` count other than one, a missing `<title>`, a missing meta description — **regardless of how few pages exhibit them**. Previously these were detected per page but lost in aggregation: `prioritizedFixes` ranked only by prevalence (so a defect on a single page was structurally excluded), the factor score averaged the defect away to a passing grade, and `crossCuttingIssues` was keyed by factor, never the specific defect. An unambiguous, high-impact defect on the most important page (e.g. a homepage split across four `<h1>`s, or a `/contact-us` page with none) appeared nowhere in the top-level summary. Now each defect names **every** offending page (homepage and high sitemap-`priority` pages first), and critical-severity defects are promoted to the **top** of `prioritizedFixes`. Shown even with `--top-issues`.
  - The end-of-report summaries no longer truncate: the Critical Defects block and each prioritized fix list **every** affected page (no "+N more"), and `prioritizedFixes` reports every cross-cutting issue ordered by prevalence rather than a top-5 slice — a fix the audit computed always reaches the report.
  - New `detectCriticalDefects()`, `buildCriticalDefects()`, and `SCHEMA_VERSION` exports plus `CriticalDefect`, `CriticalDefectGroup`, `CriticalDefectAffectedPage`, `CriticalDefectId`, `CriticalDefectSeverity`, and `PrioritizedFix` types. `AuditReport` gains `criticalDefects` and `schemaVersion`; `SitemapAuditReport` gains `criticalDefects` and `schemaVersion`; `SitemapPageResult` gains the page's sitemap `priority`.
  - Detection is independent of the weighted factor scores, so **no existing audit scores or grades change** (and exit codes are unaffected).

## 1.13.0 (2026-05-31)

### Added
- **`--allow-local` / `--allow-private` — target-scoped SSRF opt-out.** The audit blocks any URL resolving to a private/loopback/link-local address by default. These flags relax the guard for the **single host named on the CLI, and only that host**. Internally this is a `allowPrivateHost: <hostname>` option (not a boolean), evaluated per request hop, so a redirect or sitemap `<loc>` pointing at any other private host (cloud metadata at `169.254.169.254`, internal services) is still blocked. There is no way to disable the guard wholesale, and library/service callers that never set it stay fully protected. Removes the need for a public tunnel when auditing your own dev/staging server.
- **`--rewrite-sitemap-origin` — opt-in sitemap origin rewriting.** In `--sitemap` mode, re-homes every `<loc>` onto the origin of the target URL you passed (preserving path and query) before crawling. Use it when a sitemap hardcodes the canonical/prod domain but you want to audit a staging host or local dev server that serves the same paths. Every crawled URL is pinned to the origin you explicitly named, so there's no SSRF cost; combined with `--allow-local` it makes a local dev server's whole sitemap auditable in one command. Also exposed as `rewriteOrigin` on `SitemapAuditOptions`.
- **Static-output mode — audit built HTML offline.** Pass a filesystem path instead of a URL (`aeo-audit ./out`) to audit built HTML with no network — ideal for CI on a `next export` / `dist` / `out` directory. A `.html`/`.htm` file produces a single-page report; a directory is walked for HTML files and aggregated like sitemap mode. `--base-url` maps files to page URLs (`out/about/index.html` → `<base>/about/`); `llms.txt`, `robots.txt`, etc. are read from disk. Coverage is partial by nature — server-only signals (redirects, `X-Robots-Tag`, `Last-Modified`, `Link` headers) aren't visible from static files. New `runStaticAudit()` export plus `StaticAuditOptions` / `StaticAuditResult` types; the analyzer pipeline is shared with single-URL mode via the new `auditHtmlPage()` export.

## 1.12.0 (2026-05-31)

### Added
- **specification.website agent-readiness alignment.** Three emerging agent-readiness signals from the platform-agnostic web spec at [specification.website](https://specification.website) (Joost de Valk) are now detected:
  - **Per-page Markdown source endpoints** (`ai-readable-content`) — credits a `text/markdown` alternate `<link>` or `Link` response header so agents can fetch unrendered source instead of scraping HTML.
  - **Content Signals in robots.txt** (`ai-crawler-access`) — credits a `Content-Signal:` directive that declares machine-readable AI search/input/train preferences.
  - **A2A agent card discovery** (`agent-skill-exposure`) — credits an agent card advertised via `<link rel="agent-card">`, a `Link` header, or a `/.well-known/agent.json` reference.
  All three are additive and clamp-bounded, so existing audit scores are unchanged (no weight changes); the new signals only add credit paths and spec-cited recommendations.
- **`spec-references` module + `FACTOR_SPEC_RULES` map (exported).** New `SPEC_RULES`, `FACTOR_SPEC_RULES`, `SPEC_SITE`, and `specCitation()` exports map aeo-audit factor IDs to the exact specification.website agent-readiness rules they evaluate (with verified titles and `required`/`recommended`/`optional` statuses). Recommendations for the new signals cite the precise rule page, positioning aeo-audit as the automated conformance checker for the spec's agent-readiness category.

### Fixed
- **`--include-agent-skills` is now honored in sitemap mode.** `runSitemapAudit` only forwarded `factors` and `includeGeo` to per-page audits, so `--include-agent-skills` was silently dropped and the `agent-skill-exposure` factor never ran across a sitemap (the only workaround was `--factors agent-skill-exposure`). It now forwards `includeAgentSkills` alongside `includeGeo`. `includeLighthouse` remains intentionally excluded from sitemap mode (each PageSpeed Insights call takes 15–30s).

## 1.11.0 (2026-05-28)

### Added
- **`--require-meta` flag (#37).** New CI gate: when passed, the CLI exits `1` if any audited page lacks `<meta name="description">`, regardless of the overall (or aggregate) score-based exit rule. Previously a missing meta description surfaced as a `missing` finding under `technical-seo` but did not fail the run on otherwise-healthy sites, so the issue could silently pass CI. Works in both single-URL and sitemap modes; in sitemap mode the failure lists the offending URLs (truncated to the first three) on stderr.

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
