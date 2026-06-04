# @Canonry/aeo-audit

[![npm version](https://img.shields.io/npm/v/@ainyc/aeo-audit)](https://www.npmjs.com/package/@ainyc/aeo-audit) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**The most comprehensive open-source technical AEO (Answer Engine Optimization) audit tool.** Scores any website across 16 ranking factors that decide whether AI answer engines (ChatGPT, Perplexity, Gemini, Claude) will cite your content.

- Grade any URL across **16 AEO factors**: structured data, `llms.txt`, E-E-A-T, extractability, snippet eligibility, and more. [Scoring](docs/scoring.md)
- Audit a **whole site** from its sitemap; per-page findings roll up into ranked fixes. [Sitemap mode](docs/cli.md#sitemap-mode)
- Audit **built HTML offline** in CI: a `next export` / `dist` / `out` directory, no network. [Static output](docs/cli.md#static-output-mode)
- Detect the **platform / CMS / framework**: WordPress, Webflow, Shopify, Next.js, Vercel. [Platform detection](docs/cli.md#platform-detection)
- Opt in to **Lighthouse, geographic, and agent-skill** factors. [Optional factors](docs/scoring.md#optional-factors)
- `text`, `json`, `markdown`, and `agent` output with **CI-friendly exit codes**. [CLI reference](docs/cli.md)
- **Agent-native output**: a versioned `schemaVersion`, a slim `--format agent` decision, ranked structured fixes, and stable [finding codes](docs/finding-codes.md) so integrations key on codes, not prose. [API](docs/api.md#machine-readable-output-for-ai-agents)
- Use as a **library** ([API](docs/api.md)) or from Claude Code via the **`/aeo` skill** ([skill](docs/skill.md)).

Website: [canonry.ai](https://canonry.ai)

## Audit your site

```bash
npx @ainyc/aeo-audit https://example.com
```

Prints a graded report. Common variations:

```bash
# Every page in the sitemap, site-wide issues only
npx @ainyc/aeo-audit https://example.com --sitemap --top-issues

# JSON for CI/CD (exit 1 when score < 70)
npx @ainyc/aeo-audit https://example.com --format json

# A built directory, offline
npx @ainyc/aeo-audit ./out --base-url https://example.com
```

Full flag and mode reference: [docs/cli.md](docs/cli.md).

## From your AI coding agent

The package ships a Claude Code / ClawHub skill. [Install it](docs/skill.md#install), then:

```text
/aeo audit https://example.com
```

Modes: audit, fix, schema, `llms.txt`, monitor. See the [skill guide](docs/skill.md).

## Documentation

| Doc | What's in it |
|---|---|
| [CLI reference](docs/cli.md) | Every flag, mode, and exit code |
| [Scoring](docs/scoring.md) | The 16 factors, weights, grading scale |
| [Programmatic API](docs/api.md) | `runAeoAudit`, `runSitemapAudit`, `runStaticAudit` |
| [Skill](docs/skill.md) | `/aeo` modes and install |
| [Changelog](CHANGELOG.md) | Release history |
| [Roadmap](ROADMAP.md) | What's planned |

## Contributing

```bash
git clone https://github.com/Canonry/aeo-audit.git && cd aeo-audit
pnpm install && pnpm run typecheck && pnpm run build && pnpm test && pnpm lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
