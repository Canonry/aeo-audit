#!/usr/bin/env bash
# Build + audit the PR head into $1, then publish score / report path / audit exit.
set -uo pipefail
# shellcheck source=lib.sh disable=SC1091
source "$GITHUB_ACTION_PATH/lib.sh"

OUT="$1"
if ! aeo_run_audit "$OUT"; then
  echo "::error::aeo-audit head step failed (build error). Check build-command and target."
  exit 1
fi
if [ ! -s "$OUT" ]; then
  echo "::error::audit produced no report — is target ($TARGET) correct and did the build emit HTML?"
  exit 2
fi

SCORE=$(node "$GITHUB_ACTION_PATH/render-comment.cjs" --extract-score "$OUT")
{
  echo "score=$SCORE"
  echo "report_path=$OUT"
  echo "audit_exit=$AEO_AUDIT_EXIT"
} >>"$GITHUB_OUTPUT"
