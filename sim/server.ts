/**
 * omp-api — HTTP wrapper around the oh-my-pi SDK (production-hardened).
 *
 * Simulation of the report's wrapper tier. Same-origin/CORS notes in §4.1,
 * approval model in §4.3, session recovery contract in §12 of ARCHITECTURE.md.
 *
 * Hardening:
 *   - timing-safe bearer-token comparison
 *   - SSE enqueue guarded against closed streams (no crash on client disconnect)
 *   - process-level unhandledRejection/uncaughtException logging (no silent death)
 *   - idle session eviction (sessions are durable + resumable, so eviction is safe)
 *   - prompt size cap, per-request structured logging with duration
 *   - session cwd allowlist (CWD_ROOTS) — clients can only target mounted volumes
 *   - cwd reported on session GET
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import {
	AgentRegistry,
	SessionManager,
	createAgentSession,
	type AgentSession,
} from "@oh-my-pi/pi-coding-agent";

const PORT = Number(process.env.PORT ?? 8080);
const WORKSPACES = process.env.WORKSPACES_DIR ?? "/workspaces";
const TOKEN = process.env.OMP_API_TOKEN;
const MAX_PROMPT_CHARS = 100_000;
const IDLE_MINUTES = Number(process.env.OMP_SESSION_IDLE_MINUTES ?? 30);
const IDLE_MS = Math.max(1, IDLE_MINUTES) * 60_000;
const GIT_BRIDGE = process.env.GIT_BRIDGE ?? "/git-bridge/project.git";
const GIT_WORKSPACE = "/workspaces/git/project";
// session working directories must live under one of these container roots
// (the mounted volumes) — a client can never point a session at /etc, /root, …
const CWD_ROOTS = (process.env.CWD_ROOTS ?? "/workspaces,/projects")
	.split(",")
	.map((r) => r.trim())
	.filter(Boolean);
const enc = new TextEncoder();

interface Sess {
	session: AgentSession;
	registry: AgentRegistry;
	busy: boolean;
	cwd: string;
	lastActivity: number;
}
const sessions = new Map<string, Sess>();

function log(event: string, extra: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
}

process.on("unhandledRejection", (reason) => {
	log("unhandled_rejection", { reason: String(reason).slice(0, 500) });
});
process.on("uncaughtException", (err) => {
	log("uncaught_exception", { error: String(err).slice(0, 500) });
	// state is unknown — exit and let the supervisor (systemd/Cloud Run) replace us
	process.exit(1);
});

// Evict idle sessions: the transcript is durable and resumable, so dropping the
// in-memory runtime only costs a re-open on next use.
const evictor = setInterval(() => {
	const now = Date.now();
	for (const [id, s] of sessions) {
		if (s.busy || now - s.lastActivity < IDLE_MS) continue;
		sessions.delete(id);
		void s.session.dispose().catch(() => {});
		log("session_evicted", { sessionId: id, idleMinutes: Math.round((now - s.lastActivity) / 60000) });
	}
}, 30_000);
evictor.unref?.();

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
	try {
		ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data) ?? "{}"}\n\n`));
	} catch {
		// stream already closed (client disconnected) — nothing to deliver
	}
}

function authorized(req: Request): boolean {
	if (!TOKEN) return true;
	const provided = req.headers.get("authorization") ?? "";
	const expected = `Bearer ${TOKEN}`;
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

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

async function createSession(cwd: string, resume?: string) {
	// Private registry per session: the process-global one admits one
	// "Main" identity per generation (docs/sdk.md:97-99).
	const registry = new AgentRegistry();
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd,
		// resume: reopen a persisted session file (client survives restarts)
		sessionManager: resume ? await SessionManager.open(resume) : SessionManager.create(cwd),
		registry,
		// yolo inside the container sandbox (report §4.3); set
		// OMP_APPROVAL=restricted for tools.approvalMode: write.
		autoApprove: process.env.OMP_APPROVAL !== "restricted",
		telemetry: process.env.OMP_OTEL ? {} : undefined,
	});
	return { session, registry, modelFallbackMessage };
}

function touch(s: Sess): void {
	s.lastActivity = Date.now();
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const start = Date.now();
		let status = 500;
		try {
			const res = await handle(req);
			status = res.status;
			return res;
		} catch (e) {
			log("request_error", { path: new URL(req.url).pathname, error: String(e).slice(0, 300) });
			status = 500;
			return json({ error: { code: "internal", message: String(e).slice(0, 300) } }, 500);
		} finally {
			log("http", {
				method: req.method,
				path: new URL(req.url).pathname,
				status,
				ms: Date.now() - start,
			});
		}
	},
});

async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);

	if (req.method === "OPTIONS") return json({ ok: true }, 204);
	if (url.pathname === "/healthz")
		return json({ ok: true, sessions: sessions.size, busy: [...sessions.values()].filter((s) => s.busy).length });

	if (!authorized(req)) return json({ error: { code: "unauthorized" } }, 401);

	// POST /v1/sessions — create a session bound to a workspace dir
	if (req.method === "POST" && url.pathname === "/v1/sessions") {
		const body = (await req.json().catch(() => ({}))) as { cwd?: string; resume?: string; gitBridge?: boolean };
		const sessionId = crypto.randomUUID();
		const requestedCwd = body.gitBridge ? GIT_WORKSPACE : (body.cwd ?? `${WORKSPACES}/${sessionId}`);
		const normCwd = path.resolve(requestedCwd);
		if (!CWD_ROOTS.some((root) => normCwd === root || normCwd.startsWith(root + "/")))
			return json(
				{ error: { code: "cwd_forbidden", message: `cwd must be under one of: ${CWD_ROOTS.join(", ")}` } },
				403,
			);
		const cwd = normCwd;
		await fs.mkdir(cwd, { recursive: true });
		if (body.gitBridge) await ensureGitWorkspace(cwd);
		const { session, registry, modelFallbackMessage } = await createSession(cwd, body.resume);
		const sess: Sess = { session, registry, busy: false, cwd, lastActivity: Date.now() };
		sessions.set(sessionId, sess);
		return json({ sessionId, cwd, sessionFile: session.sessionFile, modelFallbackMessage }, 201);
	}

	const m = url.pathname.match(/^\/v1\/sessions\/([^/]+)(\/prompt|\/steer|\/abort|\/sync)?$/);
	if (m) {
		const [, id, action = ""] = m;
		const s = sessions.get(id);
		if (!s) return json({ error: { code: "not_found" } }, 404);
		touch(s);

		if (req.method === "GET" && !action)
			return json({ sessionId: id, busy: s.busy, cwd: s.cwd, sessionFile: s.session.sessionFile });

		if (req.method === "POST" && action === "/prompt") {
			if (s.busy) return json({ error: { code: "session_busy" } }, 409);
			const { text } = (await req.json()) as { text: string };
			if (!text?.trim()) return json({ error: { code: "bad_request", message: "text required" } }, 400);
			if (text.length > MAX_PROMPT_CHARS)
				return json({ error: { code: "too_large", message: `prompt exceeds ${MAX_PROMPT_CHARS} chars` } }, 413);
			s.busy = true;
			let clientGone = false;
			const stream = new ReadableStream({
				start(ctrl) {
					const push = (chunk: Uint8Array): void => {
						if (clientGone) return;
						try {
							ctrl.enqueue(chunk);
						} catch {
							clientGone = true;
						}
					};
					const unsub = s.session.subscribe((ev: object) => {
						push(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
					});
					s.session
						.prompt(text)
						.then((result) => sseFrame(ctrl, "done", result ?? { ok: true }))
						.catch((err) => sseFrame(ctrl, "error", { message: String(err) }))
						.finally(() => {
							unsub();
							s.busy = false;
							try {
								ctrl.close();
							} catch {
								// stream already closed — nothing to deliver
							}
						});
				},
				cancel() {
					// client disconnected: the turn keeps running server-side,
					// but stop trying to write to the dead stream
					clientGone = true;
				},
			});
			return new Response(stream, {
				headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" },
			});
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

		if (req.method === "DELETE" && !action) {
			sessions.delete(id);
			await s.session.dispose();
			return json({ ok: true }, 200);
		}
	}

	return json({ error: { code: "not_found" } }, 404);
}

console.log(`omp-api listening on :${PORT} (workspaces: ${WORKSPACES}, idle evict: ${IDLE_MINUTES}min)`);

process.on("SIGTERM", () => {
	void (async () => {
		clearInterval(evictor);
		for (const s of sessions.values()) await s.session.dispose().catch(() => {});
		process.exit(0);
	})();
});
