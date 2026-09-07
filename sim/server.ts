/**
 * omp-api — thin HTTP wrapper around the oh-my-pi SDK.
 * Simulation of the report's wrapper tier (report §3.1/§3.2/§6.3).
 *
 * Cloud mapping:
 *   published docker port   ->  global LB + IAP/OIDC (bearer token here)
 *   /state volume           ->  persistent disk; host ~/.omp import = Secret Manager
 *   /workspaces volume      ->  per-tenant workspace storage
 *   SIGTERM handling        ->  Cloud Run / systemd lifecycle
 */
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import {
	AgentRegistry,
	SessionManager,
	createAgentSession,
	type AgentSession,
} from "@oh-my-pi/pi-coding-agent";

const PORT = Number(process.env.PORT ?? 8080);
const WORKSPACES = process.env.WORKSPACES_DIR ?? "/workspaces";
const TOKEN = process.env.OMP_API_TOKEN;
const enc = new TextEncoder();

const GIT_BRIDGE = process.env.GIT_BRIDGE ?? "/git-bridge/project.git";
const GIT_WORKSPACE = "/workspaces/git/project";

async function sh(script: string, cwd: string): Promise<{ ok: boolean; out: string }> {
	const p = Bun.spawn(["bash", "-c", script], { cwd, stdout: "pipe", stderr: "pipe" });
	const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
	return { ok: (await p.exited) === 0, out };
}

/** Ensure the git-bridge workspace is a clone of the shared bare repo (cloud analog: GitHub). */
async function ensureGitWorkspace(cwd: string): Promise<void> {
	await fs.mkdir(cwd, { recursive: true });
	if (!existsSync(`${cwd}/.git`)) await sh(`git clone ${JSON.stringify(GIT_BRIDGE)} . || git init -b main`, cwd);
	await sh(`git config user.email agent@omp.local && git config user.name "omp agent"`, cwd);
	await sh(
		`git remote remove bridge 2>/dev/null; git remote add bridge ${JSON.stringify(GIT_BRIDGE)}; git fetch bridge 2>/dev/null || true`,
		cwd,
	);
	const hasHead = await sh("git rev-parse --verify HEAD", cwd);
	if (!hasHead.ok) {
		const remoteMain = await sh("git rev-parse --verify bridge/main", cwd);
		if (remoteMain.ok) await sh("git checkout -B main bridge/main", cwd);
	}
}

interface Sess {
	session: AgentSession;
	registry: AgentRegistry;
	busy: boolean;
	cwd: string;
}
const sessions = new Map<string, Sess>();

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers": "authorization, content-type",
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { ...CORS, "content-type": "application/json" },
	});
}

function sseFrame(ctrl: ReadableStreamDefaultController, event: string, data: unknown): void {
	ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data) ?? "{}"}\n\n`));
}

function authorized(req: Request): boolean {
	if (!TOKEN) return true;
	return req.headers.get("authorization") === `Bearer ${TOKEN}`;
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

		if (url.pathname === "/healthz") return json({ ok: true, sessions: sessions.size });

		if (!authorized(req)) return json({ error: { code: "unauthorized" } }, 401);

		// POST /v1/sessions — create a session bound to a workspace dir
		if (req.method === "POST" && url.pathname === "/v1/sessions") {
			const body = (await req.json().catch(() => ({}))) as { cwd?: string; resume?: string; gitBridge?: boolean };
			const sessionId = crypto.randomUUID();
			const cwd = body.gitBridge ? GIT_WORKSPACE : (body.cwd ?? `${WORKSPACES}/${sessionId}`);
			await fs.mkdir(cwd, { recursive: true });
			if (body.gitBridge) await ensureGitWorkspace(cwd);
			// Private registry per session: the process-global one admits one
			// "Main" identity per generation (docs/sdk.md:97-99).
			const registry = new AgentRegistry();
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd,
				// resume: reopen a persisted session file (client survives wrapper restarts)
				sessionManager: body.resume ? await SessionManager.open(body.resume) : SessionManager.create(cwd),
				registry,
				// yolo inside the container sandbox (report §4.3); set
				// OMP_APPROVAL=restricted for tools.approvalMode: write.
				autoApprove: process.env.OMP_APPROVAL !== "restricted",
				telemetry: process.env.OMP_OTEL ? {} : undefined,
			});
			sessions.set(sessionId, { session, registry, busy: false, cwd });
			return json({ sessionId, cwd, sessionFile: session.sessionFile, modelFallbackMessage }, 201);
		}

		const m = url.pathname.match(/^\/v1\/sessions\/([^/]+)(\/prompt|\/steer|\/abort|\/sync)?$/);
		if (m) {
			const [, id, action = ""] = m;
			const s = sessions.get(id);
			if (!s) return json({ error: { code: "not_found" } }, 404);

			if (req.method === "GET" && !action)
				return json({ sessionId: id, busy: s.busy, sessionFile: s.session.sessionFile });

			if (req.method === "POST" && action === "/prompt") {
				if (s.busy) return json({ error: { code: "session_busy" } }, 409);
				const { text } = (await req.json()) as { text: string };
				if (!text?.trim()) return json({ error: { code: "bad_request", message: "text required" } }, 400);
				s.busy = true;
				const stream = new ReadableStream({
					start(ctrl) {
						const unsub = s.session.subscribe((ev: object) => {
							ctrl.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
						});
						s.session
							.prompt(text)
							.then(result => sseFrame(ctrl, "done", result ?? { ok: true }))
							.catch(err => sseFrame(ctrl, "error", { message: String(err) }))
							.finally(() => {
								unsub();
								s.busy = false;
								ctrl.close();
							});
					},
				});
				return new Response(stream, {
					headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" },
				});
			}

			if (req.method === "POST" && action === "/sync") {
				const nothingStaged = await sh("git add -A && git diff --cached --quiet", s.cwd);
				let committed = false;
				let commitOut = "";
				if (!nothingStaged.ok) {
					const c = await sh(`git commit -m ${JSON.stringify(`omp: sync ${new Date().toISOString()}`)}`, s.cwd);
					committed = c.ok;
					commitOut = c.out;
				}
				const remoteMain = await sh("git rev-parse --verify bridge/main", s.cwd);
				const pull = remoteMain.ok ? await sh("git pull --rebase bridge main", s.cwd) : { ok: true, out: "" };
				const push = await sh("git push bridge main", s.cwd);
				const output = [commitOut, pull.out, push.out].filter(Boolean).join("\n").slice(-1500);
				if (!push.ok) return json({ error: { code: "sync_failed", message: "git push failed", output } }, 500);
				return json({ committed, pushed: true, output });
			}

			if (req.method === "POST" && action === "/steer") {
				const { text } = (await req.json()) as { text: string };
				await s.session.steer(text);
				return json({ ok: true }, 202);
			}

			if (req.method === "POST" && action === "/abort") {
				await s.session.abort();
				return json({ ok: true }, 202);
			}

			if (req.method === "DELETE" && !action) {
				sessions.delete(id);
				await s.session.dispose();
				return new Response(null, { status: 204, headers: CORS });
			}
		}

		return json({ error: { code: "not_found" } }, 404);
	},
});

console.log(`omp-api listening on :${PORT} (workspaces: ${WORKSPACES})`);

process.on("SIGTERM", () => {
	void (async () => {
		for (const s of sessions.values()) await s.session.dispose().catch(() => {});
		process.exit(0);
	})();
});
