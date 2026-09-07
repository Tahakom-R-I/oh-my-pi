#!/usr/bin/env bash
# deploy.sh — deploy omp behind an HTTP API in Docker (container variant).
#
# Mapping:
#   container            = the application server
#   published port       = LB / direct exposure (bearer token = the access gate)
#   state volume         = persistent disk  (host ~/.omp import = Secret Manager)
#   workspaces volume    = tenant workspace storage
#   git-bridge volume    = commit-based code sync with machines outside the host
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
#   IMPORT_HOST_OMP_CONFIG=1   copy host ~/.omp credentials into container state
#                              (admin workstation only — the host vault must be trusted)
#   OMP_APPROVAL=restricted    run sessions with tools.approvalMode=write instead of yolo
#   OMP_SESSION_IDLE_MINUTES=30  idle session eviction (safe: transcripts are durable)
#   OMP_OTEL=1                 enable OpenTelemetry spans on the agent loop
set -euo pipefail

IMAGE=omp-server:kit
NAME=omp-server
PORT=${PORT:-8080}
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN_DIR="$KIT_DIR/run"
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
	docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
	docker run --rm -u 0 -v "$RUN_DIR":/mnt "$IMAGE" sh -c 'rm -rf /mnt/state /mnt/workspaces /mnt/git-bridge' 2>/dev/null || true
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
command -v openssl >/dev/null || die "openssl required"

# --- state + credential import (cloud analog: Secret Manager / auth-broker) --
mkdir -p "$RUN_DIR/state/.omp/agent" "$RUN_DIR/workspaces" "$RUN_DIR/git-bridge"
if [[ ${IMPORT_HOST_OMP_CONFIG:-0} == 1 && -f "$HOME/.omp/agent/agent.db" ]]; then
	echo ">> importing host omp credentials into container state (Secret Manager analog)"
	sqlite3 "$HOME/.omp/agent/agent.db" ".backup '$RUN_DIR/state/.omp/agent/agent.db'"
	for f in config.yml models.yml models.db; do
		if [[ -f "$HOME/.omp/agent/$f" ]]; then
			cp "$HOME/.omp/agent/$f" "$RUN_DIR/state/.omp/agent/"
		fi
	done
else
	echo ">> no host omp config imported; configure credentials via environment or models.yml"
fi

# --- build ---------------------------------------------------------------------
echo ">> building $IMAGE"
docker build -f "$KIT_DIR/Dockerfile" -t "$IMAGE" "$KIT_DIR"

# Run as the host user so agent-created files are user-owned (no root-owned
# leftovers in bind mounts). One-time chown of existing volume contents.
docker run --rm -u 0 -v "$RUN_DIR":/mnt "$IMAGE" \
	chown -R "$(id -u):$(id -g)" /mnt/state /mnt/workspaces >/dev/null 2>&1 || true

TOKEN=${OMP_API_TOKEN:-$(openssl rand -hex 24)}
echo "$TOKEN" > "$RUN_DIR/token"

# --- port pre-flight: fail early and clearly on a foreign port holder ---------
# (our own previous container holding the port is fine — cleanup replaces it)
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
	if docker ps --filter "name=$NAME" --format '{{.Ports}}' | grep -q ":$PORT->"; then
		echo ">> port $PORT is held by the previous $NAME deployment (replacing it)"
	else
		die "port $PORT is already in use by another service — stop it first, or deploy with PORT=<free port>"
	fi
fi
cleanup

# --- environment ---------------------------------------------------------------
ENV_ARGS=()
for k in OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN GEMINI_API_KEY MISTRAL_API_KEY \
	GROQ_API_KEY XAI_API_KEY OPENROUTER_API_KEY AZURE_OPENAI_API_KEY ZAI_API_KEY LITELLM_API_KEY; do
	[[ -n ${!k:-} ]] && ENV_ARGS+=(-e "$k=${!k}")
done
for passthrough in OMP_SESSION_IDLE_MINUTES OMP_APPROVAL OMP_OTEL; do
	[[ -n ${!passthrough:-} ]] && ENV_ARGS+=(-e "$passthrough=${!passthrough}")
done
MOUNT_ARGS=()

# Persistent extra mounts recorded by the web console / API (run/mounts.json)
if [[ -f "$RUN_DIR/mounts.json" ]]; then
	while IFS=$'\t' read -r host container; do
		[[ -n $host && -d $host ]] || continue
		MOUNT_ARGS+=(-v "$host:$container")
		echo ">> mounting $host -> $container"
	done < <(jq -r '.[] | "\(.host)\t\(.container)"' "$RUN_DIR/mounts.json" 2>/dev/null)
fi

# Projects root: one rw mount exposing a whole host tree at /projects —
# any directory under it becomes a dynamic working directory, no restarts.
if [[ -n ${PROJECTS_ROOT:-} ]]; then
	PR=$(realpath "$PROJECTS_ROOT")
	[[ -d $PR ]] || die "PROJECTS_ROOT is not a directory: $PROJECTS_ROOT"
	MOUNT_ARGS+=(-v "$PR:/projects")
	echo ">> projects root: $PR -> /projects (dynamic working directories)"
fi

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
echo "deployment: $NAME"
echo "API:       $BASE   (healthz, /v1/sessions, /v1/sessions/:id/prompt)"
echo "Token:     $TOKEN   (saved in $RUN_DIR/token)"
echo "Web UI:    ui/start.sh   (http://localhost:8090 — login token in ui/.ui-token)"
echo "Try:       curl -sS -H \"Authorization: Bearer \$(cat $RUN_DIR/token)\" $BASE/healthz"
echo "Logs:      docker logs -f $NAME"
echo "Teardown:  deploy.sh --down   (or --clean to wipe everything)"
