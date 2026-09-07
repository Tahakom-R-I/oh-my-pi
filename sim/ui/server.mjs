#!/usr/bin/env node
/**
 * sim/ui/server.mjs — host-side backend + static server for the omp web UI.
 *
 * Zero dependencies (Node >= 20). Run:  node sim/ui/server.mjs
 * Env:  OMP_UI_PORT=8090  OMP_UI_HOST=127.0.0.1  OMP_UI_TOKEN=<hex>
 *       OMP_API_URL=http://127.0.0.1:8080  OMP_CONTAINER=omp-vm
 *
 * Why a host-side backend: only the host can (a) see host directories for
 * seeding, (b) hold the container bearer token. The browser talks exclusively
 * to this server (same-origin, cookie auth); the container token never leaves
 * the host process.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const WORKSPACES = path.join(SIM_ROOT, "run", "workspaces");
const CONTAINER_TOKEN_FILE = path.join(SIM_ROOT, "run", "token");
const UI_TOKEN_FILE = path.join(__dirname, ".ui-token");
const PORT = Number(process.env.OMP_UI_PORT ?? 8090);
const HOST = process.env.OMP_UI_HOST ?? "127.0.0.1";
const CONTAINER_BASE = process.env.OMP_API_URL ?? "http://127.0.0.1:8080";
const CONTAINER_NAME = process.env.OMP_CONTAINER ?? "omp-vm";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JSON_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
function uiToken() {
  if (process.env.OMP_UI_TOKEN) return process.env.OMP_UI_TOKEN;
  try {
    const t = fs.readFileSync(UI_TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(UI_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(UI_TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}
const UI_TOKEN = uiToken();
const COOKIE = `ui_token=${UI_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;

const loginAttempts = [];

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function hasValidAuth(req) {
  const m = (req.headers.cookie ?? "").match(/(?:^|;\s*)ui_token=([A-Za-z0-9]+)/);
  if (m && safeEqual(m[1], UI_TOKEN)) return true;
  const header = req.headers["x-ui-token"];
  return typeof header === "string" && safeEqual(header, UI_TOKEN);
}

function loginThrottled() {
  const now = Date.now();
  while (loginAttempts.length && now - loginAttempts[0] > 60_000) loginAttempts.shift();
  return loginAttempts.length >= 5;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj, null, 2));
}

function sendErr(res, status, code, message, extra = {}) {
  send(res, status, { error: { code, message, ...extra } });
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "too_large", status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { code: "bad_request", status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function containerToken() {
  try {
    return fs.readFileSync(CONTAINER_TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function runGit(args, { cwd, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

function workspacePath(name) {
  if (!NAME_RE.test(name ?? "")) return null;
  return path.join(WORKSPACES, name);
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function handleHealth(res) {
  let container = false;
  let containerError = null;
  try {
    const r = await fetch(`${CONTAINER_BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
    container = r.ok;
  } catch (e) {
    containerError = e.cause?.code ?? e.message;
  }
  let workspaces = [];
  try {
    workspaces = (await fsp.readdir(WORKSPACES, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {}
  send(res, 200, { ui: true, container, containerError, workspaces });
}

async function handleListWorkspaces(res) {
  await fsp.mkdir(WORKSPACES, { recursive: true });
  const entries = await fsp.readdir(WORKSPACES, { withFileTypes: true });
  const out = [];
  for (const e of entries.filter((d) => d.isDirectory() && !d.name.startsWith("."))) {
    const dir = path.join(WORKSPACES, e.name);
    // only treat the workspace itself as a repo — never a parent (git walks up)
    const isRepo = isGitRepo(dir);
    let remote = null;
    if (isRepo) {
      const r = await runGit(["config", "--get", "remote.origin.url"], { cwd: dir, timeoutMs: 5000 });
      remote = r.code === 0 ? r.out.trim() : null;
    }
    let mtime = null;
    try {
      mtime = (await fsp.stat(dir)).mtime.toISOString();
    } catch {}
    out.push({ name: e.name, git: isRepo, remote, mtime });
  }
  send(res, 200, { workspaces: out });
}

async function handleSeed(res, body) {
  const { type, name } = body ?? {};
  const dest = workspacePath(name);
  if (!dest) return sendErr(res, 400, "bad_name", "workspace name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  if (await fsp.stat(dest).then(() => true, () => false))
    return sendErr(res, 409, "exists", `workspace '${name}' already exists`, { hint: "pick another name, or remove it first" });
  await fsp.mkdir(WORKSPACES, { recursive: true });

  if (type === "git") {
    let url;
    try {
      url = new URL(body.url ?? "");
    } catch {
      return sendErr(res, 400, "bad_url", "invalid git URL");
    }
    if (!["https:", "http:", "ssh:", "file:", "git:"].includes(url.protocol))
      return sendErr(res, 400, "bad_url", `unsupported protocol: ${url.protocol}`);
    const r = await runGit(["clone", url.href, dest]);
    if (r.code !== 0) {
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
      return sendErr(res, 502, "clone_failed", "git clone failed", { stderr: r.err.slice(-1500) });
    }
    return send(res, 201, { ok: true, workspace: name, source: url.href });
  }

  if (type === "local") {
    const srcRaw = body.path ?? "";
    let src;
    try {
      src = path.resolve(srcRaw);
      await fsp.access(src);
    } catch {
      return sendErr(res, 400, "bad_path", `not an accessible directory: ${srcRaw}`);
    }
    if ((await fsp.stat(src)).isDirectory() !== true)
      return sendErr(res, 400, "bad_path", `not a directory: ${src}`);
    const simResolved = path.resolve(SIM_ROOT);
    if (src === simResolved || src.startsWith(simResolved + path.sep))
      return sendErr(res, 400, "forbidden_path", "refusing to seed a directory inside sim/ — it contains container state");
    await fsp.cp(src, dest, {
      recursive: true,
      filter: (s) => !/(^|[/\\])node_modules([/\\]|$)/.test(s),
    });
    return send(res, 201, {
      ok: true,
      workspace: name,
      note: `snapshot of ${src}; the container edits the live copy in sim/run/workspaces/${name}`,
    });
  }

  return sendErr(res, 400, "bad_type", "type must be 'git' or 'local'");
}

async function handleWorkspaceAction(res, name, action, body) {
  const dir = workspacePath(name);
  if (!dir) return sendErr(res, 400, "bad_name", "invalid workspace name");
  if (!(await fsp.stat(dir).then(() => true, () => false)))
    return sendErr(res, 404, "not_found", `workspace '${name}' does not exist`);

  if (action === "update") {
    if (!isGitRepo(dir))
      return sendErr(res, 400, "not_git", "workspace is not a git repository");
    const r = await runGit(["pull", "--ff-only"], { cwd: dir, timeoutMs: 120_000 });
    if (r.code !== 0)
      return sendErr(res, 502, "pull_failed", "git pull failed", { stderr: (r.err + r.out).slice(-1500) });
    return send(res, 200, { ok: true, output: (r.out + r.err).slice(-1500) });
  }

  if (action === "push") {
    const isRepo = isGitRepo(dir);
    if (!isRepo && !body?.remote)
      return sendErr(res, 400, "no_remote", "workspace is not a git repo — provide remote (GitHub repo URL) to publish it");
    const git = (...args) => runGit(args, { cwd: dir, timeoutMs: 300_000 });
    if (!isRepo) {
      const init = await git(["init", "-b", "main"]);
      if (init.code !== 0) return sendErr(res, 500, "init_failed", "git init failed", { stderr: init.err.slice(-800) });
      await git(["remote", "add", "origin", body.remote]);
    }
    await git(["add", "-A"]);
    await git(["commit", "-m", body?.message ?? "update from omp UI"]); // no-op when nothing changed
    const push = await git(["push", "-u", "origin", "HEAD"]);
    if (push.code !== 0)
      return sendErr(res, 502, "push_failed", "git push failed", { stderr: (push.err + push.out).slice(-1500) });
    return send(res, 200, { ok: true, output: (push.out + push.err).slice(-1500) });
  }

  if (action === "export") {
    let dest;
    try {
      dest = path.resolve(body?.dest ?? "");
      if (!dest) throw new Error();
    } catch {
      return sendErr(res, 400, "bad_path", "dest (host directory) required");
    }
    const simResolved = path.resolve(SIM_ROOT);
    if (dest === simResolved || dest.startsWith(simResolved + path.sep))
      return sendErr(res, 400, "forbidden_path", "refusing to export inside sim/");
    if (await fsp.stat(dest).then(() => true, () => false)) {
      if (!body?.overwrite) return sendErr(res, 409, "dest_exists", "destination exists", { hint: "set overwrite: true to merge into it" });
    }
    await fsp.mkdir(dest, { recursive: true });
    await fsp.cp(dir, dest, { recursive: true, force: true, filter: (s) => !/(^|[/\\])node_modules([/\\]|$)/.test(s) });
    return send(res, 200, { ok: true, exported: dest });
  }

  if (action === "remove") {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      // legacy root-owned files (pre non-root container) — clear from inside
      const cleaned = await new Promise((resolve) => {
        const p = spawn("docker", ["exec", CONTAINER_NAME, "rm", "-rf", `/workspaces/${name}`]);
        p.on("close", (code) => resolve(code === 0));
        p.on("error", () => resolve(false));
      });
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (await fsp.stat(dir).then(() => true, () => false))
        return sendErr(res, 500, "remove_failed", "could not fully remove workspace", {
          hint: cleaned
            ? "container cleanup ran but files remain — check sim/run/workspaces permissions"
            : `clear root-owned files from inside the container: docker exec ${CONTAINER_NAME} rm -rf /workspaces/${name}`,
        });
    }
    return send(res, 200, { ok: true });
  }

  return sendErr(res, 404, "not_found", "unknown workspace action");
}

// ---------------------------------------------------------------------------
// proxying
// ---------------------------------------------------------------------------
async function proxyJson(res, targetPath, { method = "GET", body } = {}) {
  const token = containerToken();
  if (!token) return sendErr(res, 503, "not_deployed", "container token missing — run: bash sim/simulate.sh");
  let upstream;
  try {
    upstream = await fetch(CONTAINER_BASE + targetPath, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(JSON_TIMEOUT),
    });
  } catch (e) {
    return sendErr(res, 502, "container_unreachable", `omp container at ${CONTAINER_BASE} is unreachable (${e.cause?.code ?? e.message ?? e})`);
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  res.end(text);
}

async function proxySSE(req, res, targetPath, body) {
  const token = containerToken();
  if (!token) return sendErr(res, 503, "not_deployed", "container token missing — run: bash sim/simulate.sh");
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  let upstream;
  try {
    upstream = await fetch(CONTAINER_BASE + targetPath, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: abort.signal,
    });
  } catch (e) {
    if (!abort.signal.aborted)
      return sendErr(res, 502, "container_unreachable", `omp container unreachable (${e.cause?.code ?? e.message ?? e})`);
    return;
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return sendErr(res, upstream.status, "prompt_failed", text.slice(0, 1000) || `HTTP ${upstream.status}`);
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch {
    // upstream aborted (abort/timeout) — client sees a closed stream
  }
  res.end();
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendErr(res, 403, "forbidden", "nope");
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, index) => {
        if (err2) return sendErr(res, 404, "not_found", "UI files missing");
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(index);
      });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;

  try {
    if (!p.startsWith("/api/")) return serveStatic(req, res, p);

    if (p === "/api/login" && (req.method === "POST" || req.method === "DELETE")) {
      if (req.method === "DELETE") {
        res.setHeader("Set-Cookie", "ui_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
        return send(res, 200, { ok: true });
      }
      if (loginThrottled()) return sendErr(res, 429, "throttled", "too many failed logins — wait a minute");
      const body = await readBody(req);
      if (!safeEqual(body.token ?? "", UI_TOKEN)) {
        loginAttempts.push(Date.now());
        return sendErr(res, 401, "bad_token", "invalid UI token");
      }
      res.setHeader("Set-Cookie", COOKIE);
      return send(res, 200, { ok: true });
    }

    if (!hasValidAuth(req)) return sendErr(res, 401, "unauthorized", "login required");

    if (p === "/api/health" && req.method === "GET") return await handleHealth(res);
    if (p === "/api/workspaces" && req.method === "GET") return await handleListWorkspaces(res);
    if (p === "/api/seed" && req.method === "POST") return await handleSeed(res, await readBody(req));

    let m;
    if ((m = p.match(/^\/api\/workspaces\/([^/]+)\/(update|push|export|remove)$/)) && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      return await handleWorkspaceAction(res, decodeURIComponent(m[1]), m[2], body);
    }

    if (p === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      return await proxyJson(res, "/v1/sessions", { method: "POST", body });
    }

    if ((m = p.match(/^\/api\/sessions\/([^/]+)(\/prompt|\/steer|\/abort)?$/))) {
      const id = encodeURIComponent(m[1]);
      const action = m[2] ?? "";
      if (!action && req.method === "GET") return await proxyJson(res, `/v1/sessions/${id}`);
      if (action === "/prompt" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        if (!body?.text?.trim()) return sendErr(res, 400, "bad_request", "text required");
        return await proxySSE(req, res, `/v1/sessions/${id}/prompt`, { text: body.text });
      }
      if ((action === "/steer" || action === "/abort") && req.method === "POST") {
        const body = action === "/steer" ? await readBody(req).catch(() => ({})) : undefined;
        return await proxyJson(res, `/v1/sessions/${id}${action}`, { method: "POST", body });
      }
      if (!action && req.method === "DELETE") return await proxyJson(res, `/v1/sessions/${id}`, { method: "DELETE" });
    }

    return sendErr(res, 404, "not_found", `no API route: ${req.method} ${p}`);
  } catch (e) {
    if (!res.headersSent) sendErr(res, e.status ?? 500, e.code ?? "internal", e.message);
    else res.end();
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`omp UI: port ${PORT} is already in use.`);
    console.error("  another instance is probably running — open it in your browser, or pick another port:");
    console.error(`  OMP_UI_PORT=${PORT + 1} node sim/ui/server.mjs`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`omp UI:    http://${HOST}:${PORT}`);
  console.log(`UI token:  ${UI_TOKEN}   (also in ${UI_TOKEN_FILE}; override with OMP_UI_TOKEN)`);
  console.log(`container: ${CONTAINER_BASE} (token from ${CONTAINER_TOKEN_FILE})`);
});
