#!/usr/bin/env bash
# Resolve the comparison baseline into $BASE_OUT for the committed / base-rebuild /
# artifact strategies, then publish has_baseline + path + score. A missing baseline
# is a soft state (the gate honours --on-missing-baseline) — never a silent pass.
set -uo pipefail
# shellcheck source=lib.sh disable=SC1091
source "$GITHUB_ACTION_PATH/lib.sh"

BASE_OUT="$RUNNER_TEMP/aeo-base-${SITE_ID}.json"
MISS=""

case "$BASELINE" in
  committed)
    P="${BASELINE_PATH/\$\{site-id\}/$SITE_ID}"
    if [ -f "$P" ]; then cp "$P" "$BASE_OUT"; else MISS="MISSING"; fi
    ;;
  base-rebuild)
    if [ -z "${BASE_SHA:-}" ]; then
      MISS="NO_PR_BASE"
    else
      WT="$RUNNER_TEMP/aeo-base-wt-${SITE_ID}"
      if git worktree add --detach "$WT" "$BASE_SHA" 2>/dev/null; then
        if ! (cd "$WT" && aeo_run_audit "$BASE_OUT"); then MISS="BASE_BUILD_FAILED"; fi
        git worktree remove --force "$WT" 2>/dev/null || true
      else
        MISS="NO_HISTORY"
      fi
    fi
    ;;
  artifact)
    # The latest SUCCESSFUL run on the default branch is the only trusted producer
    # of the baseline artifact. Resolve its run id explicitly — `gh run download -n`
    # with no run id pulls from the CURRENT run, which never has this artifact.
    RUN_ID=$(gh run list --repo "$REPO" --branch "$DEFAULT_BRANCH" --workflow "$WORKFLOW" \
      --status success --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    if [ -n "$RUN_ID" ] && gh run download "$RUN_ID" --repo "$REPO" \
      -n "aeo-baseline-${SITE_ID}" -D "$RUNNER_TEMP/aeo-art" 2>/dev/null; then
      cp "$RUNNER_TEMP/aeo-art"/*.json "$BASE_OUT" 2>/dev/null || MISS="MISSING"
    else
      MISS="MISSING"
    fi
    ;;
  *)
    echo "::error::Unknown baseline strategy: $BASELINE (use committed | base-rebuild | artifact)."
    exit 2
    ;;
esac

if [ -s "$BASE_OUT" ] && [ -z "$MISS" ]; then
  SCORE=$(node "$GITHUB_ACTION_PATH/render-comment.cjs" --extract-score "$BASE_OUT")
  {
    echo "has_baseline=true"
    echo "path=$BASE_OUT"
    echo "score=$SCORE"
  } >>"$GITHUB_OUTPUT"
else
  {
    echo "has_baseline=false"
    echo "miss_reason=${MISS:-MISSING}"
  } >>"$GITHUB_OUTPUT"
  echo "::warning::No baseline resolved (${MISS:-MISSING}); gating on --on-missing-baseline / absolute floor only."
fi
