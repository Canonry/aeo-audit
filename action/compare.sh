#!/usr/bin/env bash
# Diff head vs baseline via `aeo-audit compare`, then publish CI outputs + the
# Markdown path. The verdict and exit code are owned by the CLI — this script never
# re-derives them. committed/artifact baselines run --strict-comparability because
# matched audit settings can't be guaranteed by construction.
set -uo pipefail
# shellcheck source=lib.sh disable=SC1091
source "$GITHUB_ACTION_PATH/lib.sh"

REG="$RUNNER_TEMP/aeo-regression-${SITE_ID}.json"
MD="$RUNNER_TEMP/aeo-compare-${SITE_ID}.md"
{
  echo "regression_path=$REG"
  echo "md_path=$MD"
} >>"$GITHUB_OUTPUT"

ARGS=(compare --current "$HEAD_PATH" --format json --md-out "$MD"
  --overall-tolerance "$OTOL" --page-tolerance "$PTOL" --factor-tolerance "$FTOL"
  --on-missing-baseline "$ONMISS")

if [ "$FAILCRIT" = "true" ]; then
  ARGS+=(--fail-on-new-critical)
else
  ARGS+=(--no-fail-on-new-critical)
fi
[ -n "$FAILON" ] && ARGS+=(--fail-on "$FAILON")
[ "$REPORTONLY" = "true" ] && ARGS+=(--report-only)

if [ "$HAS_BASE" = "true" ]; then
  ARGS+=(--baseline "$BASE_PATH")
  case "$BASELINE" in
    committed | artifact) ARGS+=(--strict-comparability) ;;
  esac
fi

aeo_engine "${ARGS[@]}" >"$REG"
CMP_EXIT=$?

# exit 2 = misconfiguration; compare wrote its reason to stderr and may not have
# produced parseable JSON, so only extract outputs when the run was diffable.
if [ "$CMP_EXIT" != "2" ] && [ -s "$REG" ]; then
  node "$GITHUB_ACTION_PATH/render-comment.cjs" --extract-outputs "$REG" >>"$GITHUB_OUTPUT"
fi
echo "compare_exit=$CMP_EXIT" >>"$GITHUB_OUTPUT"
