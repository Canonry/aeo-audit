#!/usr/bin/env bash
# Shared helpers for the Agent Readiness Guard composite action. Sourced by the step
# scripts; reads configuration from the environment set in action.yml. No values
# are interpolated from `${{ }}` — every dynamic input arrives via an env block.

# Run the agent-readiness engine with the given argv. Defaults to the published package
# pinned to the resolved version. AGENT_READINESS_ENGINE_CMD overrides the executable (e.g.
# "node /path/to/bin/agent-readiness.js") — used by this repo's own dogfood CI to exercise
# the action against the local build before the version is published. It is split on
# whitespace, so it must not contain paths with spaces.
agent_readiness_engine() {
  if [ -n "${AGENT_READINESS_ENGINE_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $AGENT_READINESS_ENGINE_CMD "$@"
  else
    npx -y "@canonry/agent-readiness@${VER}" "$@"
  fi
}

# Populate the global AGENT_READINESS_ARGS array from MODE/TARGET/BASE_URL/REQ_META/EXTRA.
# audit-args (EXTRA) is trusted maintainer config, split on whitespace into argv;
# SSRF-relaxing flags and --lighthouse-in-static are rejected so they can't be
# smuggled into a network-capable engine.
agent_readiness_build_args() {
  AGENT_READINESS_ARGS=("$TARGET")
  case "$MODE" in
    sitemap) AGENT_READINESS_ARGS+=("--sitemap") ;;
    static) [ -n "${BASE_URL:-}" ] && AGENT_READINESS_ARGS+=("--base-url" "$BASE_URL") ;;
  esac
  [ "${REQ_META:-false}" = "true" ] && AGENT_READINESS_ARGS+=("--require-meta")

  if [ -n "${EXTRA:-}" ]; then
    local extra_arr token
    read -r -a extra_arr <<<"$EXTRA"
    for token in "${extra_arr[@]}"; do
      case "$token" in
        --allow-local | --allow-private | --rewrite-sitemap-origin)
          echo "::error::audit-args may not contain $token (it relaxes the SSRF guard)."
          exit 1
          ;;
        --format)
          echo "::error::audit-args may not set --format (the action controls output format)."
          exit 1
          ;;
        --lighthouse)
          if [ "$MODE" = "static" ]; then
            echo "::error::--lighthouse needs a live URL and cannot run in static mode."
            exit 1
          fi
          AGENT_READINESS_ARGS+=("$token")
          ;;
        *) AGENT_READINESS_ARGS+=("$token") ;;
      esac
    done
  fi
}

# Build (if BUILD_CMD is set) then audit into $1. Sets AGENT_READINESS_AUDIT_EXIT to the engine
# exit code — the engine prints the JSON report BEFORE its own non-zero exit, so the
# report file is always populated and the caller decides what the exit means. Returns
# non-zero ONLY when the build command itself fails (so a base-rebuild can tell a
# broken base build from a low score), never merely because the audit scored < 70.
agent_readiness_run_audit() {
  local out="$1"
  if [ -n "${BUILD_CMD:-}" ]; then
    if ! bash -c "$BUILD_CMD"; then
      echo "::error::build-command failed: $BUILD_CMD"
      return 1
    fi
  fi
  agent_readiness_build_args
  agent_readiness_engine "${AGENT_READINESS_ARGS[@]}" --format json >"$out"
  # AGENT_READINESS_AUDIT_EXIT is consumed by the caller (audit.sh) after sourcing, not within this file.
  # shellcheck disable=SC2034
  AGENT_READINESS_AUDIT_EXIT=$?
  return 0
}
