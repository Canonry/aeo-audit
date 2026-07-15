#!/usr/bin/env bash
# Manual, commit-addressed agent-node deployment for the single AEO audit container.
# The container uses host networking so its loopback bridge URL reaches the platform
# process, while AEO_AUDIT_BIND=127.0.0.1 keeps Caddy as the only public ingress.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="${AEO_AUDIT_HOST_DATA_DIR:-/home/arberx/fleet-data/aeo-audit}"
ENV_FILE="${AEO_AUDIT_ENV_FILE:-/home/arberx/fleet-data/aeo-audit.env}"
SERVING_NAME="aeo-audit-api"
CANDIDATE_NAME="aeo-audit-api-candidate"
PREVIOUS_IMAGE_FILE="$DATA_DIR/previous-image"
SERVING_PORT=4700
CANDIDATE_PORT=4701
SERVICE_UID=$(id -u)
SERVICE_GID=$(id -g)

cd "$REPO_DIR"
test -f "$ENV_FILE" || { echo "missing service env file: $ENV_FILE" >&2; exit 1; }
install -d -m 700 "$DATA_DIR"

run_container() {
  local name="$1"
  local image="$2"
  local port="$3"
  local data_dir="$4"
  local restart="$5"
  docker run -d \
    --name "$name" \
    --network host \
    --restart "$restart" \
    --cpus=1 \
    --memory=512m \
    --pids-limit=256 \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --user "$SERVICE_UID:$SERVICE_GID" \
    --env-file "$ENV_FILE" \
    -e "PORT=$port" \
    -e AEO_AUDIT_BIND=127.0.0.1 \
    -e AEO_AUDIT_AGENT_NODE=1 \
    -e AEO_AUDIT_DATA_DIR=/data \
    -v "$data_dir:/data" \
    "$image" >/dev/null
}

wait_for_health() {
  local port="$1"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

smoke_unknown_key() {
  local port="$1"
  local random_key
  random_key="aak_$(openssl rand -hex 32)"
  local status
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    -H "Authorization: Bearer $random_key" \
    "http://127.0.0.1:$port/v1/me")
  test "$status" = "401"
}

start_serving() {
  local image="$1"
  docker rm -f "$SERVING_NAME" >/dev/null 2>&1 || true
  run_container "$SERVING_NAME" "$image" "$SERVING_PORT" "$DATA_DIR" unless-stopped
  wait_for_health "$SERVING_PORT" && smoke_unknown_key "$SERVING_PORT"
}

if [ "${1:-}" = "--rollback" ]; then
  test -s "$PREVIOUS_IMAGE_FILE" || { echo "no previous image recorded" >&2; exit 1; }
  start_serving "$(cat "$PREVIOUS_IMAGE_FILE")"
  echo "rolled back AEO audit API to $(cat "$PREVIOUS_IMAGE_FILE")"
  exit 0
fi

COMMIT=$(git rev-parse HEAD)
IMAGE="canonry/aeo-audit-api:${COMMIT}"
PREVIOUS_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$SERVING_NAME" 2>/dev/null || true)

docker build -f apps/api/Dockerfile -t "$IMAGE" .

SCRATCH_DIR=$(mktemp -d "$DATA_DIR/candidate.XXXXXX")
cleanup() {
  docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_DIR"
}
trap cleanup EXIT INT TERM

docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
run_container "$CANDIDATE_NAME" "$IMAGE" "$CANDIDATE_PORT" "$SCRATCH_DIR" no
wait_for_health "$CANDIDATE_PORT"
smoke_unknown_key "$CANDIDATE_PORT"
docker rm -f "$CANDIDATE_NAME" >/dev/null

if [ -n "$PREVIOUS_IMAGE" ]; then
  printf '%s\n' "$PREVIOUS_IMAGE" > "$PREVIOUS_IMAGE_FILE"
  chmod 600 "$PREVIOUS_IMAGE_FILE"
fi

if ! start_serving "$IMAGE"; then
  echo "candidate failed after serving swap" >&2
  docker rm -f "$SERVING_NAME" >/dev/null 2>&1 || true
  if [ -n "$PREVIOUS_IMAGE" ]; then
    start_serving "$PREVIOUS_IMAGE"
    echo "restored previous image $PREVIOUS_IMAGE" >&2
  fi
  exit 1
fi

echo "deployed AEO audit API $IMAGE on 127.0.0.1:$SERVING_PORT"
