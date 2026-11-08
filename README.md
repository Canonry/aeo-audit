<h1 align="center">
  <a href="https://canonry.ai"><img src="https://raw.githubusercontent.com/Canonry/canonry/main/apps/web/public/apple-touch-icon.png" alt="Canonry" width="64" valign="middle" /></a> Agent Readiness
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@canonry/agent-readiness"><img src="https://img.shields.io/npm/v/@canonry/agent-readiness?style=flat&amp;label=npm&amp;color=D93F45" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@canonry/agent-readiness"><img src="https://img.shields.io/npm/dt/@canonry/agent-readiness?style=flat&amp;label=downloads&amp;color=D93F45" alt="Total npm downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-D93F45?style=flat" alt="License: MIT" /></a>
  <a href="https://discord.gg/8K9yY7GywJ"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&amp;logoColor=white" alt="Join the Canonry Discord" /></a>
  <a href="https://x.com/canonry_ai"><img src="https://img.shields.io/badge/X-000000?logo=x&amp;logoColor=white" alt="Follow Canonry on X" /></a>
  <img src="https://img.shields.io/badge/CLI%20%7C%20Library%20%7C%20Skill%20%7C%20GitHub%20Action-4493F8?style=flat-square" alt="Interfaces: CLI, library, agent skill, and GitHub Action" />
</p>

<p align="center">
  <strong>The open-source website agent readiness audit.</strong><br/>
  Score how well AI agents and answer engines can reach, read, and cite your site across 16 factors, from <code>llms.txt</code> and AI crawler access to structured data and extractable content. Run it from your terminal, your coding agent, or CI, and get ranked fixes your agent can act on.<br/>
  <sub>Open source · No API keys · Runs offline on built HTML</sub>
</p>

<h3 align="center"><a href="#quick-start"><ins>Quick start</ins></a> &nbsp;·&nbsp; <a href="#what-it-checks"><ins>What it checks</ins></a></h3>

<p align="center"><sub>Formerly <code>@canonry/aeo-audit</code> · <a href="CHANGELOG.md#800-2026-11-07">What changed in 8.0</a></sub></p>

```bash
npx @canonry/agent-readiness https://example.com
```

## Features

### Built for Agents

Every audit returns a versioned JSON report, so an agent can act on it without reading prose.

- **CLI:** `--format agent` returns the score, a pass/fail decision, and ranked fixes. `--format json` returns the full report. [CLI →](docs/cli.md)
- **Library:** typed entry points for one page, a sitemap, a full-site crawl, or built HTML. [API →](docs/api.md)
- **Skill:** `/agent-readiness` runs audits, fixes, schema checks, and `llms.txt` generation in Claude Code, and installs from ClawHub. [Skill →](docs/skill.md)
- **Stable codes:** every finding carries a code such as `technical-seo.h1.multiple`, and `schemaVersion` versions the report shape. [Finding codes →](docs/finding-codes.md)

### Site-Wide Audits

Audit every page in a sitemap from the CLI, or crawl the whole site from its root, sitemaps, and internal links with the library. Pages that share a template roll up into one fix, and critical defects and site-wide gaps rank first. [Sitemap mode →](docs/cli.md#sitemap-mode) · [Full crawl →](docs/api.md#full-site-crawl)

### Offline CI Audits

Point it at your build output (`./out`, `dist/`, `public/`). It audits the HTML with no network calls, so the same commit always gets the same score. [Static mode →](docs/cli.md#static-output-mode)

### Regression Gate

`compare` diffs two reports and fails when a score drops, a page stops auditing, or a new structural defect appears. The Agent Readiness Guard GitHub Action builds your site, runs the gate, and posts the diff as a PR comment. [Compare →](docs/cli.md#compare-mode-regression-gate) · [GitHub Action →](action/README.md)

**Also in the box:**

- **[Platform detection](docs/cli.md#platform-detection)** — Find the CMS, site builder, framework, or host behind a site, for one URL or a whole list.
- **[Preview audits](docs/cli.md#changed-page-sitemap-mode)** — Audit a local or staging build against production's sitemap, limited to the pages a branch changed.
- **[Optional factors](docs/scoring.md#optional-factors)** — Agent skill exposure (MCP, A2A agent cards, Schema.org actions), geographic signals, and Lighthouse.
- **[Spec references](https://specification.website/spec/agent-readiness/)** — Recommendations cite the matching rule in the specification.website Agent Readiness checklist.
- **[Private-network guard](docs/cli.md#auditing-a-local-or-private-target)** — Private and loopback addresses stay blocked unless you name the host with `--allow-local`.

**An example job for your coding agent:**

> Audit our site's agent readiness, fix the top three site-wide issues in this repo, then audit the build again to confirm the score went up.

---

## What it checks

Each page gets a 0–100 score for every factor and a weighted overall score. Weights are relative, and each factor reports its real share of the score as `sharePct`. A factor that doesn't apply to a page is left out of that page's score. [Scoring →](docs/scoring.md)

**Reach:** can AI crawlers and agents get to the page and use it?

<p>
  <kbd>AI Crawler Access</kbd> &nbsp;
  <kbd>AI Access Files (llms.txt, sitemap)</kbd> &nbsp;
  <kbd>Snippet Eligibility</kbd>
</p>

**Read:** can they parse what the page says?

<p>
  <kbd>Structured Data (JSON-LD)</kbd> &nbsp;
  <kbd>Schema Completeness</kbd> &nbsp;
  <kbd>Schema Validity</kbd> &nbsp;
  <kbd>Content Extractability</kbd> &nbsp;
  <kbd>Content Depth</kbd> &nbsp;
  <kbd>Definition Blocks</kbd> &nbsp;
  <kbd>FAQ Content</kbd> &nbsp;
  <kbd>Technical SEO</kbd>
</p>

**Cite:** does the page give them reasons to trust and cite it?

<p>
  <kbd>E-E-A-T Signals</kbd> &nbsp;
  <kbd>Citations &amp; Authority Signals</kbd> &nbsp;
  <kbd>Entity Consistency</kbd> &nbsp;
  <kbd>Named Entities</kbd> &nbsp;
  <kbd>Content Freshness</kbd>
</p>

**Optional, off by default:**

<p>
  <kbd>Agent Skill Exposure</kbd> &nbsp;
  <kbd>Geographic Signals</kbd> &nbsp;
  <kbd>Lighthouse</kbd>
</p>

**Works with your agent:**

<p>
  <a href="docs/skill.md#install"><kbd><img src="https://www.google.com/s2/favicons?domain=claude.ai&amp;sz=64" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://clawhub.ai/arberx/agent-readiness"><kbd><img src="https://www.google.com/s2/favicons?domain=clawhub.ai&amp;sz=64" alt="ClawHub logo" width="16" valign="middle" /> ClawHub</kbd></a> &nbsp;
  <a href="action/README.md"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&amp;sz=64" alt="GitHub logo" width="16" valign="middle" /> GitHub Actions</kbd></a> &nbsp;
  <kbd>+ any shell-capable agent</kbd>
</p>

---

## Quick start

### With your agent

Paste this into Claude Code, Codex, or any shell-capable coding agent.

<details>
<summary>Copy the audit request</summary>

```text
Audit my website's agent readiness with @canonry/agent-readiness, then help me fix what it finds.

Use the official docs:
- README: https://github.com/Canonry/agent-readiness#readme
- CLI reference: https://github.com/Canonry/agent-readiness/blob/main/docs/cli.md
- Scoring: https://github.com/Canonry/agent-readiness/blob/main/docs/scoring.md

1. Ask for my public URL. Do not run anything yet.
2. Run `npx @canonry/agent-readiness@8 "<url>" --sitemap --format agent`, with the URL quoted as one argument. Reject a URL that contains shell metacharacters. If the site has no sitemap, rerun without `--sitemap` to audit that one page.
3. Report the score, whether it passed, any critical defects, and the top fixes with the pages each one affects. Treat `limited` and `opportunity` issues as page-specific tune-ups, not site-wide gaps.
4. If this repository builds the site, find the templates and files behind each fix. Propose the changes and wait for my approval before editing anything.
5. After editing, build the site and audit the output offline with `npx @canonry/agent-readiness@8 ./<build-dir> --base-url "<url>" --format agent` to check each fix before I deploy.
```

</details>

### With the skill

```bash
git clone https://github.com/Canonry/agent-readiness.git /tmp/agent-readiness
cp -r /tmp/agent-readiness/skills/agent-readiness ~/.claude/skills/
```

Then ask Claude Code:

```text
/agent-readiness audit https://example.com
```

The skill also runs `fix`, `schema`, `llms`, `monitor`, `detect-platform`, and `compare`. It is on [ClawHub](https://clawhub.ai/arberx/agent-readiness) too. [Skill guide →](docs/skill.md)

### On your own

```bash
npx @canonry/agent-readiness https://example.com
```

It prints a scored report and exits `1` when the score is below 70. Requires Node.js 20 or later.

<details>
<summary>Audit a whole site, built output, or a local server</summary>

```bash
# Every page in the sitemap, site-wide issues only
npx @canonry/agent-readiness https://example.com --sitemap --top-issues

# The decision for an agent: score, pass/fail, and ranked fixes as JSON
npx @canonry/agent-readiness https://example.com --sitemap --format agent

# Built HTML, offline
npx @canonry/agent-readiness ./out --base-url https://example.com

# A local dev server, with its sitemap moved onto localhost
npx @canonry/agent-readiness http://localhost:3000 --sitemap --rewrite-sitemap-origin --allow-local
```

Every flag and exit code: [CLI reference](docs/cli.md).

</details>

<details>
<summary>Use it as a library</summary>

```bash
npm install @canonry/agent-readiness
```

```ts
import { runAgentReadinessAudit, runSiteCrawl } from '@canonry/agent-readiness'

const page = await runAgentReadinessAudit('https://example.com/pricing')
console.log(page.overallScore)

const site = await runSiteCrawl('https://example.com', { mode: 'summary', maxPages: 500 })
console.log(site.summary.terminationReason)
```

Entry points, options, and report types: [Programmatic API](docs/api.md).

</details>

<details>
<summary>Gate pull requests in GitHub Actions</summary>

```yaml
# .github/workflows/agent-readiness.yml
on:
  pull_request: { branches: [main] }
permissions:
  contents: read
jobs:
  readiness-gate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write          # for the sticky PR comment
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4   # the engine needs Node >= 20
        with: { node-version: 20, cache: pnpm }
      - uses: Canonry/agent-readiness/action@v8
        with:
          build-command: "pnpm install --frozen-lockfile && pnpm run build"
          target: "./out"
          base-url: "https://www.example.com"
```

The first run has no baseline, so it passes and its comment shows how to seed one. Baselines, monorepos, tolerances, and every input: [Agent Readiness Guard](action/README.md).

</details>

## Part of Canonry

Agent Readiness is the audit engine behind Site Health in [Canonry](https://github.com/Canonry/canonry), the open-source agent-first AEO platform. Canonry runs the full-site crawl on a schedule, keeps every run, maps the internal links between pages, and puts the results beside mention and citation tracking across ChatGPT, Claude, Gemini, and Perplexity.

<a href="https://github.com/Canonry/canonry#site-health"><picture><source media="(max-width: 600px)" srcset="https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/readme/site-health-mobile.png" /><img src="https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/readme/site-health.png" alt="Canonry Site Health: a map of 205 crawled pages and the links between them, beside a list of site sections, with sample data" width="100%" /></picture></a>

## Documentation

- **Run audits:** [CLI reference](docs/cli.md) · [Scoring](docs/scoring.md) · [Finding codes](docs/finding-codes.md)
- **Build on it:** [Programmatic API](docs/api.md) · [npm package](https://www.npmjs.com/package/@canonry/agent-readiness)
- **Use it from agents and CI:** [Skill](docs/skill.md) · [Agent Readiness Guard](action/README.md)
- **Follow releases:** [Changelog](CHANGELOG.md)

---

## Community &amp; Support

- **Discord:** Join the community on **[Discord](https://discord.gg/8K9yY7GywJ)** for help and questions.
- **Twitter / X:** Follow **[@canonry_ai](https://x.com/canonry_ai)** for updates.
- **Feedback &amp; Ideas:** Missing a check? [Open an issue](https://github.com/Canonry/agent-readiness/issues).
- **Show Support:** [Star](https://github.com/Canonry/agent-readiness) this repo to follow along.

---

## Contributing

```bash
git clone https://github.com/Canonry/agent-readiness.git && cd agent-readiness
pnpm install && pnpm run typecheck && pnpm run build && pnpm test && pnpm lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

<a href="https://github.com/Canonry/agent-readiness/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Canonry/agent-readiness" alt="Agent Readiness contributors" />
</a>

## License

[MIT](./LICENSE)
