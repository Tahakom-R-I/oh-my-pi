#!/usr/bin/env bash
# Container deployment: omp behind an HTTP API in Docker (server variant of the simulation kit) (report §3.1/§6.4).
#
# Mapping:
#   container            = the Compute Engine VM
#   published port       = global LB + IAP   (bearer token stands in for OIDC)
#   /root/.omp volume    = persistent disk  (host ~/.omp import = Secret Manager)
#   /workspaces volume   = tenant workspace storage
#   smoke test           = deployment verification
#
# Usage:
#   container/deploy.sh           build, run, smoke-test (default)
#   container/deploy.sh --down    stop + remove the container
#   container/deploy.sh --clean   --down + delete state, workspaces, and image
#
# Env:
#   PORT=8080                  host port to publish
#   OMP_API_TOKEN=<hex>        reuse a token instead of generating one
#   IMPORT_HOST_OMP_CONFIG=0   skip copying host ~/.omp credentials (Secret Manager analog)
#   OMP_APPROVAL=restricted    run sessions with tools.approvalMode=write instead of yolo
set -euo pipefail

IMAGE=omp-server:kit
NAME=omp-server
PORT=${PORT:-8080}
SIM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN_DIR="$SIM_DIR/run"
BASE="http://localhost:$PORT"

die() { echo "ERROR: $*" >&2; exit 1; }

# --- docker access: re-exec under the docker group if this shell lacks it ---
if ! docker info >/dev/null 2>&1; then
	if getent group docker | grep -qw "$(id -un)" && command -v sg >/dev/null 2>&1; then
		exec sg docker -c "$(printf '%q ' "$0" "$@")"
	fi
	die "docker daemon not accessible. One-time setup: sudo usermod -aG docker $(id -un)"
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }

case ${1:-} in
--down)
	cleanup
	echo "removed $NAME"
	exit 0
	;;
--clean)
	cleanup
	docker run --rm -v "$RUN_DIR":/mnt "$IMAGE" sh -c 'rm -rf /mnt/state /mnt/workspaces' 2>/dev/null || true
	docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
	rm -rf "$RUN_DIR"
	echo "cleaned container, image, and state"
	exit 0
	;;
"") ;;
*)
	die "usage: $0 [--down|--clean]"
	;;
esac

command -v jq >/dev/null || die "jq required"
command -v sqlite3 >/dev/null || die "sqlite3 required"

# --- state + credential import (cloud analog: Secret Manager / auth-broker) --
mkdir -p "$RUN_DIR/state/.omp/agent" "$RUN_DIR/workspaces" "$RUN_DIR/git-bridge"
if [[ ${IMPORT_HOST_OMP_CONFIG:-1} == 1 && -f "$HOME/.omp/agent/agent.db" ]]; then
	echo ">> importing host omp credentials into container state (Secret Manager analog)"
	sqlite3 "$HOME/.omp/agent/agent.db" ".backup '$RUN_DIR/state/.omp/agent/agent.db'"
	for f in config.yml models.yml models.db; do
		if [[ -f "$HOME/.omp/agent/$f" ]]; then
			cp "$HOME/.omp/agent/$f" "$RUN_DIR/state/.omp/agent/"
		fi
	done
else
	echo ">> no host omp config imported; pass provider keys via env or configure the session manually"
fi

# --- build + run --------------------------------------------------------------
echo ">> building $IMAGE"
docker build -f "$SIM_DIR/Dockerfile" -t "$IMAGE" "$SIM_DIR"

# Run as the host user so agent-created files are user-owned (no root-owned
# leftovers in bind mounts). One-time chown of existing volume contents.
docker run --rm -u 0 -v "$RUN_DIR/state:/state" -v "$RUN_DIR/workspaces:/workspaces" "$IMAGE" \
	chown -R "$(id -u):$(id -g)" /state /workspaces >/dev/null 2>&1 || true

TOKEN=${OMP_API_TOKEN:-$(openssl rand -hex 24)}
echo "$TOKEN" > "$RUN_DIR/token"
cleanup
ENV_ARGS=()
for k in OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN GEMINI_API_KEY MISTRAL_API_KEY \
	GROQ_API_KEY XAI_API_KEY OPENROUTER_API_KEY AZURE_OPENAI_API_KEY ZAI_API_KEY LITELLM_API_KEY; do
	[[ -n ${!k:-} ]] && ENV_ARGS+=(-e "$k=${!k}")
done
for passthrough in OMP_SESSION_IDLE_MINUTES OMP_APPROVAL OMP_OTEL; do
	[[ -n ${!passthrough:-} ]] && ENV_ARGS+=(-e "$passthrough=${!passthrough}")
done
MOUNT_ARGS=()
if [[ -n ${LOCAL_PROJECT:-} ]]; then
	HOST_PROJECT=$(realpath "$LOCAL_PROJECT")
	[[ -d $HOST_PROJECT ]] || die "LOCAL_PROJECT is not a directory: $LOCAL_PROJECT"
	MOUNT_ARGS+=(-v "$HOST_PROJECT:/workspaces/project")
	echo ">> mounting host project: $HOST_PROJECT -> /workspaces/project (agent edits hit real host files)"
fi

echo ">> starting $NAME on :$PORT"
docker run -d --name "$NAME" --restart unless-stopped \
	-p "$PORT:8080" \
	-v "$RUN_DIR/state:/state" \
	-v "$RUN_DIR/workspaces:/workspaces" \
	-v "$RUN_DIR/git-bridge:/git-bridge" \
	-e OMP_API_TOKEN="$TOKEN" \
	-e HOME=/state \
	--user "$(id -u):$(id -g)" \
	"${ENV_ARGS[@]}" \
	"${MOUNT_ARGS[@]}" \
	"$IMAGE" >/dev/null

echo ">> waiting for /healthz"
healthy=""
for _ in $(seq 1 60); do
	if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then healthy=1; break; fi
	sleep 1
done
if [[ -z $healthy ]]; then
	docker logs --tail 80 "$NAME" >&2
	die "container did not become healthy"
fi

# --- smoke test: create session, prompt, expect model text back ---------------
AUTH=(-H "Authorization: Bearer $TOKEN")

smoke_once() {
	local SID
	SID=$(curl -fsS -m 30 "${AUTH[@]}" -H "content-type: application/json" -d '{}' "$BASE/v1/sessions" | jq -r .sessionId) || return 1
	echo "   sessionId: $SID"
	curl -sS -N -m 120 "${AUTH[@]}" -H "content-type: application/json" \
		-d '{"text":"Reply with exactly: PONG"}' \
		"$BASE/v1/sessions/$SID/prompt" >"$RUN_DIR/smoke.sse" || return 1
	tr -d '\n' <"$RUN_DIR/smoke.sse" | grep -q "PONG"
}

echo ">> smoke test (create session + prompt)"
if smoke_once; then
	echo ">> SMOKE OK — model responded through the HTTP API"
elif smoke_once; then
	echo ">> SMOKE OK on retry — first attempt hit a provider/model flake"
else
	echo ">> SMOKE DEGRADED — API reachable but no model response (see $RUN_DIR/smoke.sse)" >&2
	tail -c 2000 "$RUN_DIR/smoke.sse" >&2 || true
fi

echo
echo "VM(sim):   $NAME"
echo "API:       $BASE   (healthz, /v1/sessions, /v1/sessions/:id/prompt)"
echo "Token:     $TOKEN   (saved in $RUN_DIR/token)"
echo "Try:       curl -sS -H \"Authorization: Bearer \$(cat $RUN_DIR/token)\" $BASE/healthz"
echo "Logs:      docker logs -f $NAME"
echo "Teardown:  container/deploy.sh --down   (or --clean to wipe everything)"
