# AEO Audit Roadmap (v1.1 -> v1.3)

## Goal
Build `@canonry/aeo-audit` into the most reliable open-source technical AEO auditor for CI and engineering teams, while laying the groundwork for competitive monitoring features.

## Positioning
- Primary market fit: engineering-first technical AEO audits (single page and site-level)
- Differentiator vs commercial suites: transparent scoring, open source workflows, CI-native output
- Non-goal for this cycle: full enterprise prompt analytics platform parity

## Success Metrics
- Adoption
  - Package published and installable from npm
  - `>= 1,000` weekly npm downloads within 90 days of publish
  - `>= 300` GitHub stars within 90 days
- Reliability
  - `0` known P1 correctness defects in scoring/parsing
  - `>= 85%` line coverage across analyzers and scoring
  - Deterministic report schema versioning with backward-compatible minor releases
- Product utility
  - Site-mode audits complete for `<= 500` URLs in one run
  - Baseline/diff reports used in CI with stable pass/fail behavior

## Release Plan

## v1.1: Trust + Distribution (2-4 weeks)

### Scope
1. Distribution and developer onboarding
2. Output contract hardening for CI use
3. Correctness regression coverage for key parsers

### Deliverables
| Area | Deliverable | Target Files | Acceptance Criteria |
|---|---|---|---|
| Publish | npm release + release checklist | `package.json`, `.github/workflows/publish.yml`, `README.md` | `npx @canonry/aeo-audit` works from public registry |
| CI Integration | Official GitHub Action wrapper | `.github/actions/aeo-audit/*`, `README.md` | Action runs with URL input and uploads JSON artifact |
| Report Contract | `reportVersion` + JSON schema file | `src/index.js`, `src/formatters/json.js`, `schemas/report.schema.json` | Reports validate against schema in CI |
| Factor Validation | strict factor flag handling in CLI and API docs | `src/cli.js`, `src/index.js`, `README.md` | Unknown factors fail fast with clear error |
| Regression Tests | robots parsing/matching and sitemap matching tests | `test/analyzers/*.test.js`, `test/fetch-page.test.js` | New tests reproduce and prevent recent regressions |

### Exit Criteria
- Release tag and npm publish completed
- CI green on Node 20 and 22
- Changelog and migration notes updated

## v1.2: Site Audit + Change Tracking (4-6 weeks)

### Scope
1. Multi-page crawl mode
2. Baseline and diff workflows
3. Factor confidence and evidence quality scoring

### Deliverables
| Area | Deliverable | Target Files | Acceptance Criteria |
|---|---|---|---|
| Crawl Mode | `--site` mode seeded from sitemap and/or URL list | `src/cli.js`, `src/index.js`, `src/fetch-page.js`, `src/site-audit.js` | Audits up to 500 URLs with summary + per-page results |
| Template Clustering | Group pages by path patterns to reduce noise | `src/site-audit.js`, `src/scoring.js` | Report shows top failing templates and affected URLs |
| Baseline Diffs | `--baseline report.json` + delta formatter | `src/cli.js`, `src/formatters/*.js` | CI output includes score deltas and new regressions |
| Confidence Signals | per-factor `confidence` field (`high/medium/low`) | `src/analyzers/*`, `src/scoring.js`, `schemas/report.schema.json` | All factors emit confidence with defined rubric |
| Performance | bounded concurrency + retry/backoff policy | `src/fetch-page.js`, `src/site-audit.js` | Site audits are resilient to transient failures |

### Exit Criteria
- Site-mode docs + examples in README
- Diff output stable and snapshot-tested
- Clear confidence rubric documented

## v1.3: Competitive Monitoring Foundations (6-8 weeks)

### Scope
1. Engine-policy aware auditing
2. Historical trend outputs
3. Plugin architecture for external providers

### Deliverables
| Area | Deliverable | Target Files | Acceptance Criteria |
|---|---|---|---|
| Policy Packs | Engine-specific crawler/policy checks (OpenAI, Google, Anthropic, Perplexity) | `src/analyzers/ai-crawler-access.js`, `src/analyzers/policy-packs/*`, `README.md` | Report includes policy-pack section with actionable failures |
| Trend Tracking | append-only history store + trend formatter | `src/history.js`, `src/cli.js`, `src/formatters/*.js` | Weekly trend report generated from local history |
| Extensibility | analyzer/plugin interface for third-party data providers | `src/plugins/*`, `src/index.js`, `CONTRIBUTING.md` | New plugin can be added without modifying core analyzers |
| Enterprise Export | SARIF + normalized JSON for dashboards | `src/formatters/sarif.js`, `src/cli.js` | Outputs import cleanly into code scanning or BI workflows |
| Benchmark Suite | public benchmark fixtures and expected scores | `test/benchmarks/*`, `test/analyzers/*.test.js` | Benchmark run verifies score stability across releases |

### Exit Criteria
- Plugin API documented and versioned
- Trend and export formats finalized
- v1.3 release notes include compatibility guarantees

## Cross-Cutting Workstreams

### Scoring Governance
- Define deterministic vs heuristic checks per factor
- Set max contribution caps for low-confidence heuristics
- Add `why` evidence snippets for each finding to improve explainability

### Quality and Security
- Add fuzz tests for robots and sitemap parsing
- Add network-hardening tests for redirect and blocked-host logic
- Add dependency and license checks in CI

### Documentation and DX
- Add `docs/` with architecture, scoring rubric, and plugin guide
- Add copy-paste CI examples for GitHub Actions and local cron workflows
- Maintain a "Known Limitations" section to reduce misuse

## Risks and Mitigations
- Risk: Heuristic scoring drift causes trust loss
  - Mitigation: Benchmark fixtures + confidence scores + release diffs
- Risk: Crawl mode becomes slow/unreliable on large sites
  - Mitigation: Concurrency controls, retries, and partial-result reporting
- Risk: Scope creep toward enterprise observability platform
  - Mitigation: Keep v1.x focused on technical audit depth and open integrations

## Implementation Order (Recommended)
1. v1.1 Distribution + schema contract
2. v1.1 parser regression tests
3. v1.2 site crawl + baseline diff
4. v1.2 confidence rubric
5. v1.3 policy packs + plugin API
6. v1.3 trend + SARIF export

## PR Breakdown Template
- PR 1: report schema + versioning + docs
- PR 2: GitHub Action wrapper + examples
- PR 3: crawl mode core + concurrency controls
- PR 4: baseline/diff output and tests
- PR 5: confidence scoring rollout
- PR 6: policy packs + plugin API + exports
