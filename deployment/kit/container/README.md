# omp Container Deployment — HTTP API, Web Console, and Remote Clients

This is the **container-based deployment variant** of omp: the agent runs
inside a Docker container behind an authenticated HTTP API, so browsers,
terminals, and automation can use it remotely. The interactive TUI flow
(binary install, §1–§12 of the kit README) is unchanged and remains the
recommended path for pure terminal use; choose this variant when you need

- an **HTTP/SSE API** for web apps and automation,
- a **web console** (workspace seeding, prompt streaming, live agent view),
- a **remote terminal client** (`omp-remote`) with persistent sessions,
- a **git bridge** for commit-based code sync with machines outside the host.

---

## 1. Layout

| Path | Purpose |
|---|---|
| `Dockerfile` | Image: Debian slim + Bun (pinned) + `@oh-my-pi/pi-coding-agent` (npm) + the HTTP wrapper (`server.ts`) |
| `server.ts` | Wrapper API: bearer auth, sessions, SSE prompt streaming, steer/abort, git-bridge publish, CORS, cwd allowlist |
| `deploy.sh` | One-command lifecycle: build → run (host-UID mapped volumes) → port pre-flight → health wait → smoke test. `--down` / `--clean` |
| `omp-remote` | Terminal client (python3 + curl): persistent sessions, full agent view (thinking, tools, todos), auto-resume |
| `git-bridge` | Commit-based code sync with machines outside the host (`seed/push/pull/log/reset`) |
| `ui/` | Web console backend + frontend (vanilla JS, no build step) |
| `ui/.ui-token` | Web console login token (auto-generated — distinct from the container API token in `run/token`) |
| `run/mounts.json` | Persistent extra bind mounts (added via the web console live-mount) |
| `ARCHITECTURE.md` | Full design document: request lifetime, multi-tenancy, hardening, scaling paths |

Runtime state lives in `run/` next to this folder (created on first deploy):
credential vault + sessions (`state/.omp`), per-session workspaces
(`workspaces/`), git-bridge repo (`git-bridge/`), API token (`token`).

## 2. Requirements

- Docker Engine ≥ 24 on a Linux host; `git`, `jq`, `sqlite3`, `curl`, `openssl` on the host.
- Outbound network from the host/container to your LLM provider.
- omp provider credentials: either an existing `~/.omp/agent/agent.db` on the
  host (imported at deploy with `IMPORT_HOST_OMP_CONFIG=1` — see §4), provider
  API keys in the environment, or a central `omp auth-broker` (kit §5).

## 3. Deploy

```sh
cd container/
./deploy.sh                     # build, run, smoke test
```

Idempotent: the pre-flight detects whether port 8080 is held by this
deployment's own previous container (replaced automatically) or by a foreign
service (clear error). Useful env:

- `PORT=…` — publish on another host port
- `OMP_API_TOKEN=<hex>` — reuse a token instead of generating one
- `IMPORT_HOST_OMP_CONFIG=1` — snapshot host omp credentials into the container state
- `PROJECTS_ROOT=<host-dir>` — mount a whole host tree at `/projects`: any
  directory under it becomes a dynamic working directory, no restarts
- `LOCAL_PROJECT=<dir>` — bind-mount one host directory at `/workspaces/project`
- `OMP_APPROVAL=restricted` — require approval for write/exec tools instead of yolo
- `OMP_SESSION_IDLE_MINUTES=30` — idle session eviction (safe: transcripts are durable)
- `OMP_OTEL=1` — OpenTelemetry spans (exporter setup is the host's)

Teardown: `./deploy.sh --down` (keep state) · `--clean` (wipe everything).

## 4. Credentials

With `IMPORT_HOST_OMP_CONFIG=1` (admin workstation only) the deploy script
snapshots the host's omp credentials into the container state volume:
`sqlite3 ~/.omp/agent/agent.db ".backup …"` plus `config.yml` / `models.yml` /
`models.db`. The container then uses the same providers/models as the host
user. Cloud analog: Secret Manager injection or the `omp auth-broker` vault
(kit §5). Otherwise pass provider keys via environment (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `ZAI_API_KEY`, …) — see `config/agent.env.example`.

## 5. Clients

**Web console** — `node ui/server.mjs` (host side; Node ≥ 20, zero deps).
Prints its URL and login token. Features: workspace seeding (git URL clone,
local-directory **live mount**, or local-directory snapshot), session
start/steer/abort, live prompt streaming (thinking, tool calls with output,
todo lists, retries), workspace export back to a host directory. The
container token stays server-side.

Note: the console login token is `ui/.ui-token` (printed at UI startup) —
distinct from the container API token (`run/token`).

**Terminal** — `./omp-remote "prompt"` from the host (or anywhere that can
reach the API; override `OMP_REMOTE_URL`/`OMP_REMOTE_TOKEN`):

```sh
./omp-remote --new
./omp-remote "Implement the TODO in src/api.rs"
./omp-remote --sync        # git-bridge workspaces: commit+push, then pull
./omp-remote --abort       # stop a running turn
```

Sessions persist across container restarts: on 404 the client transparently
resumes from the persisted transcript (`SessionManager.open`).

**Raw HTTP** — `POST /v1/sessions` → `POST /v1/sessions/:id/prompt` (SSE:
thinking, tool-call, and text-delta events, `event: done` terminator).
`GET /healthz` is the only unauthenticated route.

## 6. Working on local directories

Three ways to point the agent at host code, in increasing fidelity:

| Mechanism | How | Behavior |
|---|---|---|
| **Snapshot** (web console, "snapshot copy") | copies a host directory into `run/workspaces/<name>` | one-time import; result comes back via ⇩ export or git |
| **Live mount** (web console, "live mount") | records the directory in `run/mounts.json` and recreates the container with it bound at `/workspaces/mnt-<name>` | agent edits land **in the original directory**; mount persists across redeploys |
| **Projects root** (`PROJECTS_ROOT=<dir>` at deploy) | mounts a whole host tree at `/projects` | every directory under it is dynamically available as `/projects/<name>` — no restarts, new folders appear automatically |

Live mount notes: the container is recreated to attach the new bind (takes a
few seconds; refused while a turn is running — sessions resume afterwards);
mounts persist via `run/mounts.json` across redeploys; one mount per unique
directory. For whole-tree access prefer `PROJECTS_ROOT`.

## 7. Operations

| What | Where |
|---|---|
| Wrapper logs (JSON lines: requests, evictions, errors) | `docker logs omp-server` |
| Agent logs (date-rotated) | `run/state/.omp/logs/` |
| Transcripts (JSONL, resume source) | `run/state/.omp/agent/sessions/` |
| Credential vault | `run/state/.omp/agent/agent.db` (SQLite; treat as secret) |
| OpenTelemetry | `OMP_OTEL=1` on the session env + an OTLP exporter in the host process |

Health: `curl -s -H "Authorization: Bearer $(cat run/token)" \
http://localhost:8080/healthz` (reports live + busy session counts). The
image also carries a Docker `HEALTHCHECK`.

Common issues:

| Symptom | Fix |
|---|---|
| `deploy.sh`: port 8080 already in use | a foreign service holds it — stop it, or `PORT=<free port> ./deploy.sh`. The script replaces only its own previous deployment |
| Web console login rejects the API token | the console uses its own token: `ui/.ui-token` (printed at UI startup) — not `run/token` |
| 401/`not_found` in the console after a redeploy | the browser tab held a session that died with the old container — reload the page and send the prompt again; it auto-resumes from the transcript or starts fresh |
| UI shows "container unreachable" after `--clean` | expected: the deployment was wiped — `./deploy.sh` to bring it back |
| Live mount fails with "a turn is running" | abort the running turn first — mounting recreates the container |

## 8. Security notes

- All `/v1/*` routes require the bearer token; `GET /healthz` does not.
- Session working directories are restricted to the mounted volumes
  (`CWD_ROOTS`, default `/workspaces` + `/projects`) — a client can never
  point a session at `/etc`, `/root`, or arbitrary container paths.
- The agent runs with tool approval **yolo** inside the container sandbox —
  the isolation boundary is the container, not the approval layer. Set
  `OMP_APPROVAL=restricted` for `tools.approvalMode: write`, and/or add
  `tools.approval` deny policies in the imported `config.yml`.
- The container runs as the host UID (`--user`) with `HOME=/state`: files the
  agent creates are user-owned on the host. Legacy root-owned files from
  older deployments are handled by the UI's remove fallback.
- Project `.env` files inside workspaces are loaded by omp at boot — do not
  put secrets in seeded workspaces.
- Binding beyond `127.0.0.1`/loopback requires a real gateway (IAP/OIDC,
  authenticating reverse proxy, or VPN). The web console is localhost-only
  by default; its UI token gates the API proxy, not the public internet.
- `run/` (credentials, transcripts, tokens) is gitignored — never commit it.

## 9. Design document

`ARCHITECTURE.md` in this folder covers the request lifetime, the state
model (durable transcripts + resumable sessions), multi-tenancy options,
scaling directions, and the hardening checklist — everything marked
**[verified]** was exercised end to end (seed → prompt → tool execution →
sync → restart-resume → live-mount editing in the original directory).
