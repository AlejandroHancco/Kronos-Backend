#!/usr/bin/env bash
# Deploys api (app VM) + worker (backend VM) at a given commit. Run by the self-hosted
# GitHub Actions runner on the app VM (user ubuntu, in the docker group).
#   deploy-backend.sh <commit-sha>
# Layout on the app VM:  ~/kronos/SmartConcreteBackend, ~/kronos/KronosFrontend (siblings),
# deploy/vm-app-http/.env (api), worker reached over the internal network with ~/.ssh/kronos_internal.
set -euo pipefail

SHA="${1:?usage: deploy-backend.sh <commit-sha>}"
KRONOS_DIR="${KRONOS_DIR:-$HOME/kronos}"
REPO_DIR="$KRONOS_DIR/SmartConcreteBackend"
BACKEND_HOST="${BACKEND_HOST:-192.168.100.12}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/kronos_internal}"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "ubuntu@$BACKEND_HOST")
WORKER_IMAGE="kronos-worker:${SHA:0:12}"

log() { printf '\n==> %s\n' "$*"; }

wait_healthy() { # <container> <timeout-seconds>
  local c="$1" t="$2" s=""
  for _ in $(seq 1 $((t / 5))); do
    s="$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || true)"
    [ "$s" = healthy ] && return 0
    sleep 5
  done
  echo "Container $c not healthy after ${t}s (last: ${s:-unknown})" >&2
  docker logs --tail 50 "$c" >&2 || true
  return 1
}

log "Sync $REPO_DIR to $SHA"
git -C "$REPO_DIR" fetch --quiet origin
git -C "$REPO_DIR" checkout --quiet --force "$SHA"

cd "$REPO_DIR/deploy/vm-app-http"

log "Build api and worker images"
docker compose --env-file .env build api
docker build --quiet --target worker -t "$WORKER_IMAGE" "$REPO_DIR" >/dev/null

log "Restart api (applies pending migrations on start)"
docker compose --env-file .env up -d --no-deps api
wait_healthy vm-app-http-api-1 240

log "Ship worker image to backend ($BACKEND_HOST)"
docker save "$WORKER_IMAGE" | gzip -1 | "${SSH[@]}" 'gunzip | docker load >/dev/null'
"${SSH[@]}" "mkdir -p ~/kronos/SmartConcreteBackend/deploy/vm-worker"
"${SSH[@]}" "cat > ~/kronos/SmartConcreteBackend/deploy/vm-worker/docker-compose.yml" < "$REPO_DIR/deploy/vm-worker/docker-compose.yml"

log "Restart worker"
"${SSH[@]}" "docker tag '$WORKER_IMAGE' vm-worker-worker:latest \
  && cd ~/kronos/SmartConcreteBackend/deploy/vm-worker \
  && docker compose --env-file .env up -d --no-build"
for _ in $(seq 1 24); do
  if "${SSH[@]}" 'curl -fsS http://localhost:3001/health >/dev/null'; then ok=1; break; fi
  sleep 5
done
[ "${ok:-}" = 1 ] || { echo "Worker health check failed" >&2; "${SSH[@]}" 'docker logs --tail 50 vm-worker-worker-1' >&2 || true; exit 1; }

log "Clean up old images"
docker image prune -f >/dev/null
"${SSH[@]}" 'docker image prune -f >/dev/null' || true

log "Deployed $SHA"
