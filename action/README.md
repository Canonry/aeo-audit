# AEO Audit Guard — GitHub Action

> A **technical, static AEO audit** for CI. It builds your site, audits the rendered **HTML offline** (no deploy, no live crawl, no secrets — fully deterministic), and **fails the PR** when Answer Engine Optimization signals regress against a committed baseline. Add it with `uses: Canonry/aeo-audit/action@v4`.

## What "technical static audit" means

- **Technical, not editorial.** It scores the machine-checkable signals that decide whether an AI answer engine can parse, trust, and cite a page — structured data / JSON-LD, schema completeness & validity, `<title>` and meta description, a single clean `<h1>`, heading structure, crawler access (`robots.txt`, `llms.txt`), content extractability, snippet eligibility, named entities, and more. It does **not** grade writing quality or rank you against competitors.
- **Static, not a live crawl.** It runs against your **built HTML** (`./out`, `dist/`, `public/`) — the exact files you deploy — parsed offline with **zero network I/O**. No staging URL, no secrets, no flaky live fetches: the same commit always scores the same.
- **A gate, not just a report.** Every PR is diffed against a baseline with the engine's typed-and-tested [`compare`](../docs/cli.md#compare-mode-regression-gate) subcommand, and the build **fails** on a real regression — a dropped score, a page that stopped auditing, a new structural defect, or a per-factor slide the aggregate hides — with the per-factor diff posted as a sticky PR comment.

## Quick start

```yaml
# .github/workflows/aeo.yml
name: AEO Guard
on:
  pull_request: { branches: [main] }
  merge_group:                       # don't wedge the merge queue (see "Required checks")

permissions:
  contents: read                     # never inherit write-all

concurrency:                         # cancel superseded runs on the same PR
  group: aeo-${{ github.ref }}
  cancel-in-progress: true

jobs:
  aeo-gate:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write           # only this job; for the sticky comment
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4   # the engine needs Node >= 20
        with: { node-version: 20, cache: pnpm }
      - uses: Canonry/aeo-audit/action@v4
        with:
          mode: static
          build-command: "pnpm install --frozen-lockfile && pnpm run build"
          target: "./out"                      # Next `output: export` / Astro `dist` / Hugo `public`
          base-url: "https://www.example.com"  # REQUIRED in practice — see "Set base-url"
          baseline: committed
          baseline-path: ".aeo/baseline.default.json"
```

On the **first run** there is no committed baseline, so the gate passes and the comment tells you to seed one. Generate it and commit it:

```bash
npx @ainyc/aeo-audit@4 ./out --base-url https://www.example.com --format json > .aeo/baseline.default.json
git add .aeo/baseline.default.json && git commit -m "chore: seed AEO baseline"
```

From then on, every PR is measured against that committed baseline.

## How "regression" is defined

A build **fails** when, beyond the configured tolerances, any of these happen (all configurable):

| Dimension | Default gate | Notes |
|---|---|---|
| Overall / aggregate score drop | > `overall-tolerance` (2) | The headline number. |
| Single-page score drop | > `page-tolerance` (5) | Catches one page tanking while the aggregate hides it. |
| Single-factor score drop | > `factor-tolerance` (8) | e.g. structured-data sliding while content rises. |
| A page stops auditing | always | `success → error` is the strongest regression — and the aggregate (mean of *success* pages) would otherwise mask it. |
| New `severity:critical` defect | on (`fail-on-new-critical`) | `missing-h1`, `multiple-h1`, `missing-title`. A known template defect arriving on a **new** page is report-only, not a regression. |
| Major report-schema change | always | Regenerate the baseline. |
| Removed pages / new warnings | report-only | Promote with `fail-on: removed-pages,warnings`. `missing-meta-description` is a *warning* — use `require-meta` or `fail-on: warnings`. |

Score, page, and factor deltas only gate when the two runs are **comparable** (same factor set, no major engine change); otherwise they're reported with a loud warning instead of failing. Defaults are deliberately noise-aware so the gate stays trusted; loosen any single tolerance without disabling the gate.

## Accepting an intentional drop

When you *meant* to change content and the score legitimately moved, refresh the committed baseline in the **same PR** — the reviewer approves the score change as a normal file diff:

```bash
npx @ainyc/aeo-audit@4 ./out --base-url https://www.example.com --format json > .aeo/baseline.default.json
```

The PR comment always prints this exact command. Avoid loosening a global tolerance for a one-off drop — that permanently weakens the gate for every future PR.

## Baseline strategies

- **`committed`** (default) — a JSON report committed at `baseline-path`. Deterministic, reviewable, secret-free, and the accept-a-drop flow is just a file diff. Refresh it on merge with a separate job (below).
- **`base-rebuild`** — re-audit the PR's base SHA in the same run (needs `actions/checkout` with `fetch-depth: 0`). No stored artifact, always fresh, but ~2× build time and the base build must be reproducible in a worktree (use an isolated dependency store to avoid contaminating it with the head's `node_modules`).
- **`artifact`** — download the latest successful default-branch baseline artifact (needs `actions: read`). Cheaper than base-rebuild, subject to artifact retention.

### Refreshing a committed baseline on merge

```yaml
  aeo-baseline:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: write          # open the refresh PR
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: Canonry/aeo-audit/action@v4
        with:
          mode-of-run: update-baseline
          build-command: "pnpm install --frozen-lockfile && pnpm run build"
          target: "./out"
          base-url: "https://www.example.com"
          baseline: committed
          baseline-path: ".aeo/baseline.default.json"
          comment: "false"
      - uses: peter-evans/create-pull-request@v6
        with:
          add-paths: .aeo/baseline.default.json
          branch: chore/aeo-baseline
          commit-message: "chore: refresh AEO baseline"
          title: "chore: refresh AEO baseline"
```

It opens a reviewable PR rather than force-pushing the baseline to your default branch.

## Monorepos

Give each site a `site-id` (namespaces the baseline path, the artifact name, and the sticky comment) and run a matrix:

```yaml
    strategy:
      fail-fast: false
      matrix:
        site:
          - { id: marketing, build: "pnpm --filter ./apps/marketing build", out: apps/marketing/out, url: "https://example.com" }
          - { id: docs,      build: "pnpm --filter ./apps/docs build",      out: apps/docs/dist,     url: "https://docs.example.com" }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: Canonry/aeo-audit/action@v4
        with:
          site-id: ${{ matrix.site.id }}
          build-command: "pnpm install --frozen-lockfile && ${{ matrix.site.build }}"
          target: ${{ matrix.site.out }}
          base-url: ${{ matrix.site.url }}
```

## Set `base-url`

In `static` mode `base-url` maps files to real page URLs (`out/about/index.html → <base>/about/`) — it makes canonical / og:url checks meaningful **and** gives stable per-page diff keys. The default `https://localhost` will depress absolute scores. Set it to your production origin, identical on both sides.

## Security

- **Use `pull_request`, never `pull_request_target`.** On *fork* PRs the token is read-only with no secrets, so building the PR's code is safe-ish (the comment can't post and falls back to the job summary). On *same-repo branch* PRs the token and secrets ARE available while this action runs your `build-command` — keep the gate job's `permissions` minimal (`contents: read` + `pull-requests: write`) and put **no deploy/npm/cloud secrets in that job**.
- `build-command`, `target`, `base-url`, and `audit-args` are **trusted maintainer config** — never wire PR-author-controlled values into them. The `with:` block is part of the PR diff, so protect `.github/workflows` with branch/required-workflow rules.
- `audit-args` rejects the SSRF-relaxing flags (`--allow-local`, `--allow-private`, `--rewrite-sitemap-origin`) and `--lighthouse` in static mode. Default `static` mode does no network I/O at all.
- The engine is pinned to `@ainyc/aeo-audit@4` (never `@latest`). Pin this action and the third-party actions above to commit SHAs for full supply-chain protection.

## Required checks & events

Run the action on `pull_request` **and** `merge_group` so a required status check is produced for both PRs and the merge queue. Don't make the *job* conditional on the event in a way that skips it entirely — a required check that never reports leaves the merge queue pending forever.

## Inputs & outputs

See [`action.yml`](./action.yml) for the full list. Key outputs: `verdict` (`pass`/`fail`), `result` (`pass`/`regression`/`improvement`/`no-baseline`), `score`, `delta`, `regression-count`, `regressed-factors`, `report-json`, `regression-json`, `comment-url`. In `update-baseline` runs the gate outputs are empty.

## Exit codes

`0` clean / improvement / first-run-no-baseline; `1` regression (or below `min-absolute-score`, or `require-meta` failure); `2` misconfiguration (mode mismatch, unreadable report, incomparable factor-set/engine for a committed/artifact baseline, or a rejected `audit-args` flag).
