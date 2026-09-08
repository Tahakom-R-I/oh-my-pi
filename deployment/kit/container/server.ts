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
	type ExtensionAskDialogQuestion,
	type ExtensionUIContext,
	type ExtensionUISelectItem,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogResultItem,
} from "@oh-my-pi/pi-coding-agent";

const PORT = Number(process.env.PORT ?? 8080);
const WORKSPACES = process.env.WORKSPACES_DIR ?? "/workspaces";
const TOKEN = process.env.OMP_API_TOKEN;
const MAX_PROMPT_CHARS = 100_000;
const MAX_SESSIONS = Number(process.env.OMP_MAX_SESSIONS ?? 50);
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
// resume paths must point at persisted transcripts — under the omp state
// root ($HOME, mounted at /state) or the workspaces volume. Same containment
// idea as CWD_ROOTS: a client cannot open arbitrary container files.
const RESUME_ROOTS = (process.env.RESUME_ROOTS ?? `${process.env.HOME ?? "/state"},${WORKSPACES}`)
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
	/** Warning when a resumed session's saved model is no longer available. */
	modelFallbackMessage?: string;
	/** Interactive-dialog bridge: pending asks + the live SSE sink. */
	ui: UiBridge;
}

/** Settle a pending ui_request: undefined = user cancel / channel gone. */
type UiSettle = (value: string | undefined) => void;

interface UiBridge {
	seq: number;
	pending: Map<number, UiSettle>;
	/** Set while a /prompt SSE stream is open; pushes ui_request frames. */
	sink: ((frame: Record<string, unknown>) => void) | null;
}

function createUiBridge(): UiBridge {
	return { seq: 0, pending: new Map(), sink: null };
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
	// 204 must carry no body — constructing one with a body throws (TypeError)
	if (status === 204) return new Response(null, { status, headers: CORS });
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
	// fail closed: without OMP_API_TOKEN the server refuses to start (see
	// bottom of file); OMP_ALLOW_NO_AUTH=1 is an explicit local-testing opt-out
	if (!TOKEN) return process.env.OMP_ALLOW_NO_AUTH === "1";
	const provided = req.headers.get("authorization") ?? "";
	const expected = `Bearer ${TOKEN}`;
	const pb = Buffer.from(provided);
	const eb = Buffer.from(expected);
	// byte lengths, not UTF-16 lengths — timingSafeEqual throws on mismatch
	if (pb.length !== eb.length) return false;
	return timingSafeEqual(pb, eb);
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

async function createSession(cwd: string, resume?: string): Promise<Sess> {
	// Private registry per session: the process-global one admits one
	// "Main" identity per generation (docs/sdk.md:97-99).
	const registry = new AgentRegistry();
	const sess: Sess = {
		session: null as unknown as AgentSession,
		registry,
		busy: false,
		cwd,
		lastActivity: Date.now(),
		ui: createUiBridge(),
	};
	const { session, modelFallbackMessage, setToolUIContext } = await createAgentSession({
		cwd,
		// resume: reopen a persisted session file (client survives restarts)
		sessionManager: resume ? await SessionManager.open(resume) : SessionManager.create(cwd),
		registry,
		// register the interactive ask tool (AskTool.createIf) — answers flow
		// through the ui bridge below, rendered by the web console
		interactivePrompts: true,
		// yolo inside the container sandbox (report §4.3); set
		// OMP_APPROVAL=restricted for tools.approvalMode: write.
		autoApprove: process.env.OMP_APPROVAL !== "restricted",
		telemetry: process.env.OMP_OTEL ? {} : undefined,
	});
	sess.session = session;
	if (modelFallbackMessage) sess.modelFallbackMessage = modelFallbackMessage;
	setToolUIContext(bridgeUiContext(sess), true);
	return sess;
}

/**
 * Settle a pending ui_request. `value` undefined = user cancel.
 * Returns false when no ask is pending under that reqId.
 */
function resolveUi(s: Sess, reqId: number, value: string | undefined): boolean {
	const settle = s.ui.pending.get(reqId);
	if (!settle) return false;
	settle(value);
	return true;
}

/** Cancel every pending ui_request (stream closed / session going away). */
function cancelPendingUi(s: Sess): void {
	for (const settle of [...s.ui.pending.values()]) settle(undefined);
	s.ui.pending.clear();
}

/**
 * Push a dialog to the attached web console and wait for the answer. Without
 * a live /prompt SSE stream nobody could answer, so the ask resolves
 * undefined immediately (the ask tool treats that as cancel and aborts).
 */
function askUi(s: Sess, request: Record<string, unknown>, signal?: AbortSignal): Promise<string | undefined> {
	const sink = s.ui.sink;
	if (!sink) return Promise.resolve(undefined);
	const reqId = ++s.ui.seq;
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	let settled = false;
	const settle: UiSettle = (value) => {
		if (settled) return;
		settled = true;
		s.ui.pending.delete(reqId);
		signal?.removeEventListener("abort", onAbort);
		resolve(value);
	};
	const onAbort = (): void => settle(undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	s.ui.pending.set(reqId, settle);
	sink({ type: "ui_request", reqId, ...request });
	return promise;
}

function bridgeUiContext(s: Sess): ExtensionUIContext {
	return {
		select: (title, options, dialogOptions) =>
			askUi(
				s,
				{
					kind: "select",
					title,
					options: toWireOptions(options),
					...(dialogOptions?.selectionMarker ? { selectionMarker: dialogOptions.selectionMarker } : {}),
					...(dialogOptions?.checkedIndices ? { checkedIndices: [...dialogOptions.checkedIndices] } : {}),
					...(dialogOptions?.markableCount !== undefined ? { markableCount: dialogOptions.markableCount } : {}),
					...(dialogOptions?.helpText ? { helpText: dialogOptions.helpText } : {}),
				},
				dialogOptions?.signal,
			),
		editor: (title, prefill, dialogOptions) => askUi(s, { kind: "editor", title, prefill }, dialogOptions?.signal),
		confirm: async (title, message, dialogOptions) =>
			(await askUi(s, { kind: "select", title: `${title}\n${message}`, options: ["Yes", "No"] }, dialogOptions?.signal)) === "Yes",
		input: (title, placeholder, dialogOptions) => askUi(s, { kind: "editor", title, prefill: placeholder ?? "" }, dialogOptions?.signal),
		notify: (message, type) => s.ui.sink?.({ type: "ui_notice", level: type ?? "info", message }),
		askDialog: (questions, dialogOptions) => runAskDialog(s, questions, dialogOptions?.signal),
	} as unknown as ExtensionUIContext; // interactive subset; terminal-only members stay inert
}

const ASK_OTHER_OPTION = "Other (type your own)";
const ASK_DONE_OPTION = "Done selecting";

/**
 * Rich ask over the web console: one ui_request per round, mirroring the
 * collab guest composition (`#runGuestAskQuestion`) — radio select per
 * single-choice question, checkbox toggling for multi, `Other` routed to an
 * editor, Done gated on a non-empty selection. Returns undefined on cancel
 * (AskTool aborts the turn, matching the TUI contract).
 */
async function runAskDialog(
	s: Sess,
	questions: ExtensionAskDialogQuestion[],
	signal?: AbortSignal,
): Promise<ExtensionAskDialogResult | undefined> {
	const results: ExtensionAskDialogResultItem[] = [];
	for (const question of questions) {
		const result = await runAskQuestion(s, question, signal);
		if (result === undefined) return undefined;
		results.push(result);
	}
	return { kind: "submit", results };
}

async function runAskQuestion(
	s: Sess,
	question: ExtensionAskDialogQuestion,
	signal?: AbortSignal,
): Promise<ExtensionAskDialogResultItem | undefined> {
	const title = question.header?.trim() ? `${question.header.trim()}\n${question.question}` : question.question;
	const baseOptions = question.options.map((option) => ({ label: option.label, ...(option.description?.trim() ? { description: option.description.trim() } : {}) }));
	const selected = new Set<string>();
	let customInput: string | undefined;
	if (question.multi) {
		while (true) {
			const checkedIndices = question.options.map((option, index) => (selected.has(option.label) ? index : -1)).filter((index) => index >= 0);
			// mirror the TUI Done gating: no submit until something is checked
			const hasAnswer = selected.size > 0 || customInput !== undefined;
			const options = [...baseOptions, ASK_OTHER_OPTION, ...(hasAnswer ? [ASK_DONE_OPTION] : [])];
			const choice = await askUi(
				s,
				{
					kind: "select",
					title,
					options,
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: question.options.length,
				},
				signal,
			);
			if (choice === undefined) return undefined;
			if (choice === ASK_DONE_OPTION) break;
			if (choice === ASK_OTHER_OPTION) {
				const input = await askUi(s, { kind: "editor", title: `Custom answer: ${question.question}` }, signal);
				if (input === undefined) continue; // cancelled editor: back to the list
				customInput = input;
				break;
			}
			if (selected.has(choice)) selected.delete(choice);
			else selected.add(choice);
		}
	} else {
		const recommended = typeof question.recommended === "number" && Number.isInteger(question.recommended) ? question.recommended : 0;
		const initialIndex = Math.max(0, Math.min(recommended, Math.max(0, question.options.length - 1)));
		while (true) {
			const choice = await askUi(
				s,
				{
					kind: "select",
					title,
					options: [...baseOptions, ASK_OTHER_OPTION],
					initialIndex,
					selectionMarker: "radio",
					markableCount: question.options.length,
				},
				signal,
			);
			if (choice === undefined) return undefined;
			if (choice === ASK_OTHER_OPTION) {
				const input = await askUi(s, { kind: "editor", title: `Custom answer: ${question.question}` }, signal);
				if (input === undefined) continue; // re-show the option list
				customInput = input;
			} else {
				selected.add(choice);
			}
			break;
		}
	}
	return {
		id: question.id,
		question: question.question,
		options: question.options.map((option) => option.label),
		multi: question.multi ?? false,
		selectedOptions: question.options.map((option) => option.label).filter((label) => selected.has(label)),
		...(customInput !== undefined ? { customInput } : {}),
	};
}

function touch(s: Sess): void {
	s.lastActivity = Date.now();
}
function toWireOptions(options: ExtensionUISelectItem[]): ExtensionUISelectItem[] {
	return options.map((option) =>
		typeof option === "string" ? option : { label: option.label, ...(option.description ? { description: option.description } : {}) },
	);
}

Bun.serve({
	port: PORT,
	// SSE prompt streams sit silent while an ask waits for the user — Bun's
	// 10s default would kill the stream (and cancel the pending ask) first
	idleTimeout: 255,
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
			return json({ error: { code: "internal", message: "internal error (details in server logs)" } }, 500);
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
		if (sessions.size >= MAX_SESSIONS)
			return json(
				{ error: { code: "too_many_sessions", message: `session cap (${MAX_SESSIONS}) reached — delete one or wait for idle eviction` } },
				429,
			);
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
		// same containment invariant as cwd: a client can only reopen
		// transcripts under the state/workspaces roots, never arbitrary files
		let resume: string | undefined;
		if (body.resume) {
			const normResume = path.resolve(body.resume);
			if (!RESUME_ROOTS.some((root) => normResume === root || normResume.startsWith(root + "/")))
				return json(
					{ error: { code: "resume_forbidden", message: `resume must be under one of: ${RESUME_ROOTS.join(", ")}` } },
					403,
				);
			resume = normResume;
		}
		await fs.mkdir(cwd, { recursive: true });
		if (body.gitBridge) await ensureGitWorkspace(cwd);
		try {
			const sess = await createSession(cwd, resume);
			sessions.set(sessionId, sess);
			return json({ sessionId, cwd, sessionFile: sess.session.sessionFile, modelFallbackMessage: sess.modelFallbackMessage }, 201);
		} catch {
			// most commonly a missing/unreadable resume path — don't leak the error
			return json({ error: { code: "bad_request", message: "could not open session (missing or unreadable transcript?)" } }, 400);
		}
	}

/**
 * Replay feed for the web console: distills the persisted transcript into
 * display entries (user text, assistant text + tool calls). Thinking blocks
 * and bookkeeping entries are dropped; capped to the most recent 400 entries
 * so a page refresh stays cheap on long sessions.
 */
async function sessionHistory(s: Sess): Promise<{ entries: Record<string, unknown>[] }> {
	const file = s.session.sessionFile;
	if (!file || !existsSync(file)) return { entries: [] };
	const MAX_BYTES = 4 * 1024 * 1024;
	const stat = await fs.stat(file).catch(() => null);
	if (!stat) return { entries: [] };
	let text = await Bun.file(file).text();
	if (stat.size > MAX_BYTES) {
		// tail slice; drop the first (likely partial) line
		const buf = await Bun.file(file).slice(stat.size - MAX_BYTES).text();
		text = buf.slice(buf.indexOf("\n") + 1);
	}
	const clip = (v: string, n: number): string => (v.length <= n ? v : `${v.slice(0, n)} …`);
	const textParts = (content: unknown): string =>
		(Array.isArray(content) ? content : [])
			.map((part) => asRecord(part))
			.filter((part) => part?.type === "text")
			.map((part) => String(part.text ?? ""))
			.join("\n")
			.trim();
	const entries: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const e = asRecord(JSON.parse(line)); // parsed transcript line — shape is ours
		if (!e || e.type !== "message") continue;
		const m = asRecord(e.message);
		if (!m) continue;
		const content = m.content;
		if (m.role === "user") {
			const t = clip(textParts(content), 4000);
			if (t) entries.push({ role: "user", text: t });
		} else if (m.role === "assistant") {
			const t = textParts(content);
			const tools = (Array.isArray(content) ? content : [])
				.map((part) => asRecord(part))
				.filter((part) => part?.type === "toolCall")
				.map((part) => {
					const args = asRecord(part.arguments);
					const intent = typeof part.intent === "string" ? part.intent : typeof args?.i === "string" ? args.i : undefined;
					return { name: part.name, ...(intent ? { intent } : {}) };
				});
			if (t || tools.length)
				entries.push({ role: "assistant", ...(t ? { text: clip(t, 4000) } : {}), ...(tools.length ? { tools } : {}) });
		} else if (m.role === "toolResult") {
			const out = textParts(content);
			entries.push({
				role: "tool",
				toolName: m.toolName,
				...(m.isError === true ? { isError: true } : {}),
				...(out ? { brief: clip(out, 200) } : {}),
			});
		}
		if (entries.length > 400) entries.splice(0, entries.length - 400);
	}
	return { entries };
}

function asRecord(v: unknown): Record<string, unknown> | null {
	// parsed JSON at a trust boundary — structural narrowing instead of a type
	return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

	const m = url.pathname.match(/^\/v1\/sessions\/([^/]+)(\/prompt|\/steer|\/abort|\/sync|\/ui-response|\/history)?$/);
	if (m) {
		const [, id, action = ""] = m;
		const s = sessions.get(id);
		if (!s) return json({ error: { code: "not_found" } }, 404);
		touch(s);

		if (req.method === "GET" && !action)
			return json({ sessionId: id, busy: s.busy, cwd: s.cwd, sessionFile: s.session.sessionFile });

		if (req.method === "GET" && action === "/history")
			return json(await sessionHistory(s));

		if (req.method === "POST" && action === "/prompt") {
			if (s.busy) return json({ error: { code: "session_busy" } }, 409);
			// reject oversized bodies before buffering/parsing (4 bytes/char is
			// the UTF-8 upper bound; JSON escaping adds a little more)
			const contentLength = Number(req.headers.get("content-length") ?? 0);
			if (contentLength > MAX_PROMPT_CHARS * 5 + 1024)
				return json({ error: { code: "too_large", message: `prompt exceeds ${MAX_PROMPT_CHARS} chars` } }, 413);
			// set synchronously after the busy check — no await in between, or
			// two concurrent prompts could both pass the gate
			s.busy = true;
			const { text } = (await req.json().catch(() => ({}))) as { text?: string };
			if (!text?.trim()) {
				s.busy = false;
				return json({ error: { code: "bad_request", message: "text required" } }, 400);
			}
			if (text.length > MAX_PROMPT_CHARS) {
				s.busy = false;
				return json({ error: { code: "too_large", message: `prompt exceeds ${MAX_PROMPT_CHARS} chars` } }, 413);
			}
			let clientGone = false;
			let unsub: (() => void) | null = null;
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
					// SSE comment frames keep the connection hot during silent
					// turn gaps (shorter than the server's idleTimeout and any
					// intermediary read timeout)
					const heartbeat = setInterval(() => push(enc.encode(": keepalive\n\n")), 5_000);
					// interactive-dialog bridge: while this stream lives, tools can
					// surface select/editor asks to the web console and await
					// POST /ui-response answers
					s.ui.sink = (frame) => push(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
					unsub = s.session.subscribe((ev: object) => {
						push(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
					});
					s.session
						.prompt(text)
						.then((result) => sseFrame(ctrl, "done", result ?? { ok: true }))
						.catch((err) => {
							log("prompt_error", { sessionId: id, error: String(err).slice(0, 300) });
							sseFrame(ctrl, "error", { message: "turn failed (details in server logs)" });
						})
						.finally(() => {
							clearInterval(heartbeat);
							unsub?.();
							unsub = null;
							// nobody can answer pending asks once the stream is gone
							s.ui.sink = null;
							cancelPendingUi(s);
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
					// but detach the listener and stop encoding events
					clientGone = true;
					unsub?.();
					unsub = null;
					s.ui.sink = null;
					cancelPendingUi(s);
				},
			});
			return new Response(stream, {
				headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" },
			});
		}

		if (req.method === "POST" && action === "/steer") {
			const { text } = (await req.json().catch(() => ({}))) as { text?: string };
			if (!text?.trim()) return json({ error: { code: "bad_request", message: "text required" } }, 400);
			if (text.length > MAX_PROMPT_CHARS)
				return json({ error: { code: "too_large", message: `text exceeds ${MAX_PROMPT_CHARS} chars` } }, 413);
			await s.session.steer(text);
			return json({ ok: true }, 202);
		}

		if (req.method === "POST" && action === "/abort") {
			cancelPendingUi(s);
			await s.session.abort();
			return json({ ok: true }, 202);
		}

		if (req.method === "POST" && action === "/ui-response") {
			// answer to a ui_request pushed on the prompt SSE stream; a null
			// value is the web console's Cancel (wire has no undefined)
			const body = (await req.json().catch(() => ({}))) as { reqId?: number; value?: string | null };
			if (typeof body.reqId !== "number") return json({ error: { code: "bad_request", message: "reqId required" } }, 400);
			const answered = resolveUi(s, body.reqId, body.value ?? undefined);
			return json(answered ? { ok: true } : { error: { code: "not_pending", message: "no ask pending for reqId" } }, answered ? 200 : 409);
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
			// tearing down a busy session kills the in-flight turn's stream —
			// the idle evictor skips busy sessions, so should DELETE
			if (s.busy) return json({ error: { code: "session_busy", message: "turn running — abort it first" } }, 409);
			sessions.delete(id);
			await s.session.dispose();
			return json({ ok: true }, 200);
		}
	}

	return json({ error: { code: "not_found" } }, 404);
}

// fail closed on a missing token (Bun.serve is set up above): a bare
// `docker run` without OMP_API_TOKEN must not serve an unauthenticated,
// yolo-approved agent API. OMP_ALLOW_NO_AUTH=1 is the explicit opt-out.
if (!TOKEN && process.env.OMP_ALLOW_NO_AUTH !== "1") {
	console.error("FATAL: OMP_API_TOKEN is not set — refusing to serve. Generate one: openssl rand -hex 24");
	console.error("   (OMP_ALLOW_NO_AUTH=1 disables this check for throwaway local testing only)");
	process.exit(1);
}
if (!TOKEN) console.warn("OMP_ALLOW_NO_AUTH=1 — the API is UNAUTHENTICATED (local testing only)");

console.log(`omp-api listening on :${PORT} (workspaces: ${WORKSPACES}, idle evict: ${IDLE_MINUTES}min)`);

process.on("SIGTERM", () => {
	void (async () => {
		clearInterval(evictor);
		for (const s of sessions.values()) await s.session.dispose().catch(() => {});
		process.exit(0);
	})();
});
