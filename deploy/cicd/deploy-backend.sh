#!/usr/bin/env bash
# Deploys api (app VM) + worker (backend VM) at a given commit. Run by the self-hosted
# GitHub Actions runner on the app VM (user ubuntu, in the docker group).
#   IMAGE_PREFIX=ghcr.io/<owner> GHCR_USER=... GHCR_TOKEN=... deploy-backend.sh <commit-sha>
#
# Nothing is compiled here: GitHub Actions builds the images and publishes them to GHCR,
# tagged with the commit. This VM pulls them (only the layers that changed) and re-publishes
# the worker on a registry bound to 127.0.0.1:5000. The backend VM, which has no internet,
# pulls from that registry through an SSH reverse tunnel opened only for the pull, so the
# registry is never exposed on the network.
# The app VM keeps only configuration: $CONF_DIR/vm-app-http/.env (api + frontend).
set -euo pipefail

SHA="${1:?usage: deploy-backend.sh <commit-sha>}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF_DIR="${CONF_DIR:-$HOME/kronos/SmartConcreteBackend/deploy}"
IMAGE_PREFIX="${IMAGE_PREFIX:?set IMAGE_PREFIX, e.g. ghcr.io/<owner>}"
IMAGE_PREFIX="${IMAGE_PREFIX,,}" # registry paths must be lowercase
API_IMAGE="$IMAGE_PREFIX/kronos-api:$SHA"
WORKER_IMAGE="$IMAGE_PREFIX/kronos-worker:$SHA"
LOCAL_REGISTRY=127.0.0.1:5000
LOCAL_WORKER="$LOCAL_REGISTRY/kronos-worker:$SHA"
REGISTRY_IMAGE=registry:2.8.3
COMPOSE=(docker compose -p vm-app-http -f "$CONF_DIR/vm-app-http/docker-compose.yml" --env-file "$CONF_DIR/vm-app-http/.env")
BACKEND_HOST="${BACKEND_HOST:-192.168.100.12}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/kronos_internal}"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "ubuntu@$BACKEND_HOST")

log() { printf '\n==> %s\n' "$*"; }

# One deploy at a time on this VM: the frontend workflow takes the same lock, so its
# image cleanup can never race with this deploy.
exec 9>/tmp/kronos-deploy.lock
echo "Waiting for the deploy lock..."
flock 9

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

# Old images of this deploy (any tag but the current commit) + dangling layers.
prune_images() { # <grep -E pattern of repositories>
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^($1):" | grep -v ":$SHA\$" \
    | xargs -r docker rmi >/dev/null 2>&1 || true
  docker image prune -f >/dev/null
}

# A private docker config for this job only: the GHCR credentials never persist on the VM.
DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
if [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-github-actions}" --password-stdin >/dev/null
fi

log "Deploying $SHA"
# Install this commit's compose file next to the VM's .env; the frontend deploy uses it too.
cp "$REPO_DIR/deploy/vm-app-http/docker-compose.yml" "$CONF_DIR/vm-app-http/docker-compose.yml"

log "Pull images from GHCR"
docker pull -q "$API_IMAGE" >/dev/null
docker pull -q "$WORKER_IMAGE" >/dev/null

log "Restart api (applies pending migrations on start)"
docker tag "$API_IMAGE" vm-app-http-api:latest
"${COMPOSE[@]}" up -d --no-deps --no-build api
wait_healthy vm-app-http-api-1 240

log "Publish the worker image on the app's internal registry ($LOCAL_REGISTRY)"
if [ "$(docker inspect -f '{{.State.Running}}' kronos-registry 2>/dev/null || true)" != true ]; then
  docker rm -f kronos-registry >/dev/null 2>&1 || true
  docker run -d --name kronos-registry --restart always -p "$LOCAL_REGISTRY:5000" \
    -v kronos-registry:/var/lib/registry "$REGISTRY_IMAGE" >/dev/null
  for _ in $(seq 1 20); do curl -fsS "http://$LOCAL_REGISTRY/v2/" >/dev/null 2>&1 && break; sleep 1; done
fi
docker tag "$WORKER_IMAGE" "$LOCAL_WORKER"
docker push -q "$LOCAL_WORKER" >/dev/null

log "Pull the worker on backend ($BACKEND_HOST) and restart it"
"${SSH[@]}" "mkdir -p ~/kronos/SmartConcreteBackend/deploy/vm-worker"
"${SSH[@]}" "cat > ~/kronos/SmartConcreteBackend/deploy/vm-worker/docker-compose.yml" < "$REPO_DIR/deploy/vm-worker/docker-compose.yml"
# 127.0.0.1:5000 on backend -> 127.0.0.1:5000 on app, only while this command runs.
# Docker trusts 127.0.0.0/8 registries over plain HTTP, so backend needs no daemon change.
"${SSH[@]}" -o ExitOnForwardFailure=yes -R "$LOCAL_REGISTRY:$LOCAL_REGISTRY" \
  "docker pull -q '$LOCAL_WORKER' >/dev/null && docker tag '$LOCAL_WORKER' vm-worker-worker:latest"
"${SSH[@]}" "cd ~/kronos/SmartConcreteBackend/deploy/vm-worker \
  && docker compose --env-file .env up -d --no-build"
ok=""
for _ in $(seq 1 24); do
  if "${SSH[@]}" 'curl -fsS http://localhost:3001/health >/dev/null'; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { echo "Worker health check failed" >&2; "${SSH[@]}" 'docker logs --tail 50 vm-worker-worker-1' >&2 || true; exit 1; }

log "Clean up old images"
prune_images "$IMAGE_PREFIX/kronos-(api|worker)|$LOCAL_REGISTRY/kronos-worker|kronos-worker"
"${SSH[@]}" "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(127.0.0.1:5000/kronos-worker|kronos-worker):' \
  | grep -v ':$SHA\$' | xargs -r docker rmi >/dev/null 2>&1; docker image prune -f >/dev/null" || true

log "Deployed $SHA"
