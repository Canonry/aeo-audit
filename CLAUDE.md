# CLAUDE.md

## Project Overview

@ainyc/aeo-audit — an open-source AEO (Answer Engine Optimization) audit engine and single umbrella Claude Code / ClawHub skill. Scores websites across 16 ranking factors that determine AI citation.

Website: https://ainyc.ai

## Tech Stack

- **Language:** TypeScript (ESM)
- **Runtime:** Node.js >= 20
- **Package manager:** pnpm
- **HTML parsing:** Cheerio
- **Build:** TypeScript compiler to `dist/`
- **Typecheck:** `tsc --noEmit`
- **Test runner:** `tsx --test`
- **Linter:** ESLint v9 flat config

## Commands

```bash
pnpm install    # Install dependencies
pnpm run typecheck  # Static typecheck
pnpm run build      # Compile src/*.ts to dist/
pnpm test           # Run all tests
pnpm lint           # Run linter
```

## Key Files

```
src/
  index.ts           # Main entry: runAeoAudit(url, options)
  scoring.ts         # Factor definitions, weights, score calculation
  fetch-page.ts      # URL fetching with SSRF protection
  errors.ts          # AeoAuditError class
  cli.ts             # CLI argument parsing
  formatters/        # json, markdown, text output formatters
  analyzers/         # Per-factor analyzer modules (16 core + 2 optional) plus shared helpers.ts
  types.ts           # Shared audit/report TypeScript types
dist/                # Compiled publishable ESM output
bin/
  aeo-audit.js       # CLI entry point -> dist/cli.js
skills/aeo/          # Single umbrella Claude Code / ClawHub skill
test/                # Unit and integration tests
```

## Architecture

- Each analyzer receives a context object `{ $, html, url, headers, auxiliary, structuredData, textContent, pageTitle }` and returns `{ score, findings, recommendations }`
- Scores are weighted and normalized in `scoring.ts`; weights sum to 100% for active factors
- Geographic signals is optional (excluded by default); when included, weights renormalize
- The `--factors` flag allows running a subset of analyzers
- SSRF protection blocks private IPs and hostnames in `fetch-page.ts`
- Published entrypoints resolve to compiled `dist/` output; run `pnpm run build` before local CLI smoke tests

## Code Conventions

- Functional style, no classes except AeoAuditError
- Always use `clampScore()` for score calculations
- Findings types: `found`, `missing`, `info`, `timeout`, `unreachable`
- Unused vars starting with `_` are ignored by ESLint

## Documentation

Any change to user-visible CLI surface must update **all three** of these in the same change:

1. `printHelp()` in `src/cli.ts` — Options list **and** Examples block
2. `docs/cli.md` — the relevant mode section, the **Flag reference** table, and the **Exit codes** section (flags, examples, and any defaults). The root `README.md` only carries a handful of headline examples; the full CLI surface lives in `docs/cli.md`.
3. `skills/aeo/SKILL.md` — Examples and the relevant mode section (e.g. `### Sitemap Mode`)

This applies to:

- Adding, renaming, or removing a flag
- Changing a default value (e.g. sitemap `--limit` default of 200) — the default must be stated in the help string, `docs/cli.md`, and SKILL.md
- Adding a new CLI mode (e.g. `--sitemap`) — document flags, defaults, exit-code behavior, and an example invocation in all three places
- Changing exit-code semantics or output format options

Before opening a PR that touches `src/cli.ts`, grep `docs/cli.md` and SKILL.md for the affected flag name to confirm everything still matches.

## Versioning

Follows semver. Bump `version` in `package.json` on every change that ships:

- **Patch** (`1.3.x`) — bug fixes, scoring corrections, internal refactors with no API change
- **Minor** (`1.x.0`) — new analyzers, new CLI flags, new exported helpers (backwards-compatible)
- **Major** (`x.0.0`) — breaking changes to the public API or scoring weights that would change existing audit results

The ClawHub skill version must match `package.json`.

## ClawHub Publishing

Publish the skill to ClawHub after updating `skills/aeo/SKILL.md`.

### Verify login

```bash
clawhub whoami   # should print your handle (e.g. arberx)
```

If not logged in: `clawhub login`

### Publish

```bash
clawhub publish skills/aeo --version <semver> --changelog "<description of changes>"
```

- `--version` must be valid semver and **must match `package.json`**
- Include a short changelog summarizing what changed
- Run from the repo root (the `skills/` directory is resolved relative to cwd)

### Example

```bash
clawhub publish skills/aeo --version 1.3.3 --changelog "Fix nested schema detection and E-E-A-T signal scoping"
```

### ClawHub Security Guidelines

ClawHub flags skills as suspicious when they request excessive capabilities. Follow these rules to stay under the threshold:

- **Pin npx versions** — use `@1` (major pin) instead of `@latest`. The `@latest` tag is a supply chain risk because a compromised publish can hijack all users immediately.
- **Minimize Bash patterns** — only declare the single npx command end users need. Do not include local dev commands (`pnpm run build`, `node bin/...`) in the published skill; those are for contributors, not consumers.
- **Avoid generic Bash patterns** — `Bash(aeo-audit *)` is too broad and could match other binaries. Always use the fully qualified `npx @ainyc/aeo-audit@1 *` form.
- **Scope file permissions narrowly** — only request Edit/Write for file types the skill actually modifies. Use `Write(filename)` for specific files (e.g., `llms.txt`, `robots.txt`) instead of broad `Edit(*.txt)` patterns.
- **Keep shell injection guards** — the Argument Safety section in SKILL.md is required. Never remove it.

## GitHub Actions Conventions

- **Single trigger path per release flow.** If the workflow auto-creates a tag, do not also trigger on that tag pattern — the self-pushed tag will re-fire the workflow, causing a duplicate publish that fails with 403 on npm.
- **Never interpolate step outputs directly into `run:` blocks.** Use an `env:` block to pass values into shell scripts: `env: { VERSION: "${{ steps.x.outputs.version }}" }` then reference `$VERSION` in the script. Direct `${{ }}` interpolation in `run:` is a script-injection vector.
- **Scope permissions to the minimum required per job.** If only one step needs `contents: write` (e.g., pushing a tag), prefer splitting it into a separate job with its own permissions block rather than elevating the entire job.
- **Declare explicit `permissions` on every job.** Omitting the `permissions` block inherits the repository default, which may be `write-all`. Always declare at minimum `contents: read`.
