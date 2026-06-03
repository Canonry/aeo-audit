# Claude Code / ClawHub skill

This package ships one umbrella skill source at [`skills/aeo/SKILL.md`](../skills/aeo/SKILL.md).

ClawHub package: [arberx/aeo](https://clawhub.ai/arberx/aeo)

## Command

```text
/aeo <mode> <url> [flags]
```

## Modes

- `audit`: grading and diagnosis
- `fix`: code changes after an audit
- `schema`: JSON-LD validation
- `llms`: generate `llms.txt` and `llms-full.txt`
- `monitor`: before/after tracking or competitor comparisons

## Examples

```text
/aeo audit https://example.com
/aeo fix https://example.com
/aeo schema https://example.com
/aeo llms https://example.com
/aeo monitor https://site-a.com --compare https://site-b.com
```

## Install

```bash
# Personal install
git clone https://github.com/AINYC/aeo-audit.git /tmp/aeo-audit
cp -r /tmp/aeo-audit/skills/aeo ~/.claude/skills/

# Or project-level
cp -r /tmp/aeo-audit/skills/aeo .claude/skills/
```

## Testing the skill from this repo

If you're testing the skill from a local checkout instead of the published package, build first and use the local CLI:

```bash
pnpm run build
node bin/aeo-audit.js https://example.com --format json
```
