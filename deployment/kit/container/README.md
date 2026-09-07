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
| `Dockerfile` | Image: Debian slim + Bun + `@oh-my-pi/pi-coding-agent` (npm) + the HTTP wrapper (`server.ts`) |
| `server.ts` | Wrapper API: bearer auth, sessions, SSE prompt streaming, steer/abort, git-bridge publish, CORS |
| `deploy.sh` | One-command lifecycle: build → run (host-UID mapped volumes) → health wait → smoke test. `--down` / `--clean` |
| `omp-remote` | Terminal client (python3 + curl): persistent sessions, full agent view (thinking, tools, todos), auto-resume |
| `git-bridge` | Commit-based code sync with machines outside the host (`seed/push/pull/log/reset`) |
| `ui/` | Web console backend + frontend (vanilla JS, no build step) |
| `ARCHITECTURE.md` | Full design document: request lifetime, multi-tenancy, hardening, scaling paths |

Runtime state lives in `run/` next to this folder (created on first deploy):
credential vault + sessions (`state/.omp`), per-session workspaces
(`workspaces/`), git-bridge repo (`git-bridge/`), API token (`token`).

## 2. Requirements

- Docker Engine ≥ 24 on a Linux host; `git`, `jq`, `sqlite3`, `curl`, `openssl` on the host.
- Outbound network from the host/container to your LLM provider.
- omp provider credentials: either an existing `~/.omp/agent/agent.db` on the
  host (imported automatically at deploy — see §4), provider API keys in the
  environment, or a central `omp auth-broker` (kit §5).

## 3. Deploy

```sh
cd container/
./deploy.sh                     # build, run, import host omp creds, smoke test
```

Idempotent. What you get: container `omp-server` on port 8080, API bearer
token in `run/token`, and a smoke test that proves a model round-trip.
Useful env: `PORT=…`, `OMP_API_TOKEN=<hex>` (reuse a token),
`IMPORT_HOST_OMP_CONFIG=0` (skip credential import), `LOCAL_PROJECT=<dir>`
(bind-mount a host directory at `/workspaces/project`),
`OMP_APPROVAL=restricted` (require approval for write/exec tools instead of
yolo), `OMP_SESSION_IDLE_MINUTES=30` (idle session eviction),
`OMP_OTEL=1` (OpenTelemetry spans — exporter setup is the host's).

Teardown: `./deploy.sh --down` (keep state) · `--clean` (wipe everything).

## 4. Credentials

At deploy time the script snapshots the host's omp credentials into the
container state volume: `sqlite3 ~/.omp/agent/agent.db ".backup …"` plus
`config.yml` / `models.yml` / `models.db`. The container therefore uses the
same providers/models as the host user. Cloud analog: Secret Manager
injection or the `omp auth-broker` vault (kit §5). Skip the import with
`IMPORT_HOST_OMP_CONFIG=0` and pass provider keys via environment instead
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`, … — see
`config/agent.env.example` for the full list).

## 5. Clients

**Web console** — `node ui/server.mjs` (host side; Node ≥ 20, zero deps).
Prints its URL and UI token. Features: workspace seeding (git URL clone or
host-directory snapshot), session start/steer/abort, live prompt streaming
(thinking, tool calls with output, todo lists, retries), workspace
export back to a host directory. The container token stays server-side.

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

## 6. Getting work in and out

| Direction | Mechanism |
|---|---|
| Repo in → workspace | Web console seed (git URL), or `git clone` into `run/workspaces/<name>` on the host (bind-mounted at `/workspaces/<name>`) |
| Host directory → workspace | Web console seed (local-directory snapshot), or `LOCAL_PROJECT=<dir>` bind mount at deploy |
| Workspace → host directory | Web console ⇩ export, or `git push` + host `git pull` |
| Continuous, cross-device | Git bridge (§`git-bridge`): agent commits/pushes to the bare repo, host pulls — text-only, no shared filesystem |
| Live same-machine editing | The workspace *is* a host directory (bind mount) — open it in your editor directly |

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

## 8. Security notes

- All `/v1/*` routes require the bearer token; `GET /healthz` does not.
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

## 9. Design document

`ARCHITECTURE.md` in this folder covers the request lifetime, the state
model (durable transcripts + resumable sessions), multi-tenancy options,
scaling directions, and the hardening checklist — everything marked
**[verified]** was exercised end to end (seed → prompt → tool execution →
sync → restart-resume).
