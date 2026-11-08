# Claude Code / ClawHub skill

This package ships one umbrella skill source at [`skills/agent-readiness/SKILL.md`](../skills/agent-readiness/SKILL.md).

ClawHub package: [arberx/agent-readiness](https://clawhub.ai/arberx/agent-readiness)

## Command

```text
/agent-readiness <mode> <url> [flags]
```

## Modes

- `audit`: scoring and diagnosis
- `fix`: code changes after an audit
- `schema`: JSON-LD validation
- `llms`: generate `llms.txt` and `llms-full.txt`
- `monitor`: before/after tracking or competitor comparisons

## Examples

```text
/agent-readiness audit https://example.com
/agent-readiness fix https://example.com
/agent-readiness schema https://example.com
/agent-readiness llms https://example.com
/agent-readiness monitor https://site-a.com --compare https://site-b.com
```

## Install

```bash
# Personal install
git clone https://github.com/Canonry/agent-readiness.git /tmp/agent-readiness
cp -r /tmp/agent-readiness/skills/agent-readiness ~/.claude/skills/

# Or project-level
cp -r /tmp/agent-readiness/skills/agent-readiness .claude/skills/
```

## Testing the skill from this repo

If you're testing the skill from a local checkout instead of the published package, build first and use the local CLI:

```bash
pnpm run build
node bin/agent-readiness.js https://example.com --format json
```
