/* omp console — frontend. Vanilla JS, no build step. */
"use strict";

const $ = (sel) => document.querySelector(sel);
const LS_ACTIVE = "omp-ui-active-session";
const LS_SESSIONS = "omp-ui-sessions";

const state = { sessionId: null, cwd: null, workspace: null, busy: false };

// ---------------------------------------------------------------- helpers
function toast(msg, isErr = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), isErr ? 8000 : 3500);
}

async function jfetch(url, opts = {}, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      ...opts,
      body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      signal: opts.signal ?? ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  } finally {
    clearTimeout(timer);
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function extractText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v?.content)) {
    const joined = v.content.map((p) => p?.text ?? "").filter(Boolean).join("\n");
    if (joined) return joined;
  }
  for (const k of ["output", "text", "result", "message", "error"]) if (v[k]) return String(v[k]);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function clip(s, n = 300) {
  s = String(s).replace(/\r/g, "");
  return s.length <= n ? s : s.slice(0, n) + " …";
}

// ---------------------------------------------------------------- auth
function showLogin() {
  $("#login").classList.remove("hidden");
  $("#topbar").classList.add("hidden");
  $("#app").classList.add("hidden");
}

async function boot() {
  $("#login").classList.add("hidden");
  $("#topbar").classList.remove("hidden");
  $("#app").classList.remove("hidden");
  await refreshHealth();
  await refreshWorkspaces();
  restoreSession();
  setInterval(refreshHealth, 15000);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#login-error");
  errEl.classList.add("hidden");
  try {
    const { resp, data } = await jfetch("/api/login", { method: "POST", body: { token: $("#login-token").value } }, 10000);
    if (!resp.ok) {
      errEl.textContent = data?.error?.message ?? `login failed (HTTP ${resp.status})`;
      errEl.classList.remove("hidden");
      return;
    }
    $("#login-token").value = "";
    boot();
  } catch (err) {
    errEl.textContent = `login failed: ${err.message}`;
    errEl.classList.remove("hidden");
  }
});

$("#logout").addEventListener("click", async () => {
  await fetch("/api/login", { method: "DELETE" }).catch(() => {});
  location.reload();
});

// ---------------------------------------------------------------- health
function setDot(on, err) {
  $("#status-dot").className = "dot " + (on ? "on" : "off");
  $("#status-label").textContent = on ? "container online" : `container unreachable${err ? ` (${err})` : ""}`;
}

async function refreshHealth() {
  try {
    const { resp, data } = await jfetch("/api/health");
    if (resp.status === 401) return showLogin();
    setDot(!!data.container, data.containerError);
  } catch {
    setDot(false, "ui backend down");
  }
}

// ---------------------------------------------------------------- workspaces
async function refreshWorkspaces() {
  const box = $("#workspaces");
  try {
    const { resp, data } = await jfetch("/api/workspaces");
    if (!resp.ok) { box.replaceChildren(el("p", "muted", data?.error?.message ?? "failed to list")); return; }
    if (!data.workspaces.length) { box.replaceChildren(el("p", "muted", "no workspaces yet — seed one below")); return; }
    box.replaceChildren();
    for (const w of data.workspaces) {
      const row = el("div", "ws-item" + (state.workspace === w.name ? " active" : ""));
      const name = el("span", "name", w.name);
      name.title = w.remote ?? "no git remote (snapshot)";
      name.addEventListener("click", () => { state.workspace = w.name; refreshWorkspaces(); });
      const tag = el("span", "tag", w.git ? "git" : "dir");
      row.append(name, tag);
      if (w.git) {
        const upd = el("button", "iconbtn", "⟳");
        upd.title = "git pull";
        upd.addEventListener("click", () => workspaceAction(w.name, "update"));
        row.append(upd);
      }
      const psh = el("button", "iconbtn", "⇪");
      psh.title = "commit & push to GitHub";
      psh.addEventListener("click", () => pushWorkspace(w));
      const exp = el("button", "iconbtn", "⇩");
      exp.title = "export current state to a host directory";
      exp.addEventListener("click", () => exportWorkspace(w.name));
      const del = el("button", "iconbtn", "✕");
      del.title = "remove workspace";
      del.addEventListener("click", async () => {
        if (!confirm(`Remove workspace '${w.name}' from the container?`)) return;
        await workspaceAction(w.name, "remove");
        if (state.workspace === w.name) state.workspace = null;
      });
      row.append(exp, del);
      box.append(row);
    }
  } catch (e) {
    box.replaceChildren(el("p", "error", String(e.message ?? e)));
  }
}

async function workspaceAction(name, action, body) {
  try {
    const { resp, data } = await jfetch(`/api/workspaces/${encodeURIComponent(name)}/${action}`, {
      method: "POST", body: body ?? {},
    }, 120000);
    if (resp.status === 409 && data?.error?.code === "dest_exists") {
      if (!confirm(`Destination exists:\n${body.dest}\nMerge into it?`)) return;
      return workspaceAction(name, action, { ...body, overwrite: true });
    }
    if (!resp.ok) { toast(data?.error?.message ?? `HTTP ${resp.status}`, true); if (data?.error?.output) console.log(data.error.output); return; }
    toast(`${action} ok${data?.exported ? " → " + data.exported : ""}`);
    if (action === "remove") refreshWorkspaces();
  } catch (e) {
    toast(`${action} failed: ${e.message}`, true);
  }
}

async function pushWorkspace(w) {
  const message = prompt("Commit message:", "update from omp console");
  if (message === null) return;
  let remote;
  if (!w.git) {
    remote = prompt(`'${w.name}' is not a git repo yet.\nGitHub repo URL to publish it to (create an empty repo on github.com first):`);
    if (!remote) return;
  }
  try {
    const { resp, data } = await jfetch(`/api/workspaces/${encodeURIComponent(w.name)}/push`, { method: "POST", body: { message, remote } }, 300000);
    if (!resp.ok) {
      toast(data?.error?.message ?? `HTTP ${resp.status}`, true);
      if (data?.error?.stderr) console.log(data.error.stderr);
      return;
    }
    toast(`pushed '${w.name}' to GitHub`);
    refreshWorkspaces();
  } catch (err) {
    toast(`push failed: ${err.message}`, true);
  }
}

function exportWorkspace(name) {
  const dest = prompt(`Export current state of '${name}' to host directory:`);
  if (!dest) return;
  workspaceAction(name, "export", { dest });
}

// seed form
let seedTab = "git";
$("#tab-git").addEventListener("click", () => setSeedTab("git"));
$("#tab-local").addEventListener("click", () => setSeedTab("local"));
function setSeedTab(tab) {
  seedTab = tab;
  $("#tab-git").classList.toggle("active", tab === "git");
  $("#tab-local").classList.toggle("active", tab === "local");
  $("#seed-url").classList.toggle("hidden", tab !== "git");
  $("#seed-path").classList.toggle("hidden", tab !== "local");
  $("#seed-note").textContent = tab === "git"
    ? "Clones the repo into the container's shared workspaces volume."
    : "Copies a snapshot of a host directory into the container (container edits are visible live on the host).";
}

$("#seed-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#seed-name").value.trim();
  if (!name) return;
  const body = seedTab === "git" ? { type: "git", name, url: $("#seed-url").value.trim() } : { type: "local", name, path: $("#seed-path").value.trim() };
  const btn = $("#seed-form").querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const { resp, data } = await jfetch("/api/seed", { method: "POST", body }, 600000);
    if (!resp.ok) { toast(data?.error?.message ?? `HTTP ${resp.status}`, true); return; }
    toast(`workspace '${name}' seeded`);
    $("#seed-name").value = "";
    state.workspace = name;
    await refreshWorkspaces();
  } catch (err) {
    toast(`seed failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- sessions
function sessionsList() {
  try { return JSON.parse(localStorage.getItem(LS_SESSIONS) ?? "[]"); } catch { return []; }
}
function saveSessions(list) { localStorage.setItem(LS_SESSIONS, JSON.stringify(list.slice(0, 30))); }

function renderSessionChip() {
  const chip = $("#session-chip");
  if (!state.sessionId) { chip.classList.add("hidden"); return; }
  chip.classList.remove("hidden");
  chip.textContent = `${state.workspace ?? "session"} · ${state.sessionId.slice(0, 8)}${state.cwd ? " · " + state.cwd : ""}`;
}

function renderSessionList() {
  const box = $("#sessions");
  const list = sessionsList();
  if (!list.length) { box.replaceChildren(el("p", "muted", "no sessions yet")); return; }
  box.replaceChildren();
  for (const s of list.slice(0, 12)) {
    const row = el("div", "sess-item" + (s.sessionId === state.sessionId ? " active" : ""));
    row.append(el("span", "name", `${s.workspace ?? "session"} · ${s.sessionId.slice(0, 8)}`));
    row.addEventListener("click", () => activateSession(s));
    const del = el("button", "iconbtn", "✕");
    del.title = "forget (does not delete server-side)";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      saveSessions(sessionsList().filter((x) => x.sessionId !== s.sessionId));
      renderSessionList();
    });
    row.append(del);
    box.append(row);
  }
}

function rememberActive() {
  if (!state.sessionId) return;
  localStorage.setItem(LS_ACTIVE, JSON.stringify({ sessionId: state.sessionId, cwd: state.cwd, workspace: state.workspace }));
  const list = sessionsList().filter((s) => s.sessionId !== state.sessionId);
  list.unshift({ sessionId: state.sessionId, cwd: state.cwd, workspace: state.workspace, ts: Date.now() });
  saveSessions(list);
}

function activateSession(s) {
  state.sessionId = s.sessionId;
  state.cwd = s.cwd ?? null;
  state.workspace = s.workspace ?? null;
  rememberActive();
  renderSessionChip();
  renderSessionList();
  clearStream(`resumed session ${s.sessionId.slice(0, 8)} — history is on the server; send a prompt to continue.`);
}

function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_ACTIVE) ?? "null");
    if (s?.sessionId) activateSession(s);
  } catch {}
}

async function startSession(workspace) {
  if (!workspace) { toast("select a workspace first", true); return; }
  try {
    const { resp, data } = await jfetch("/api/sessions", { method: "POST", body: { cwd: `/workspaces/${workspace}` } });
    if (!resp.ok) { toast(data?.error?.message ?? `HTTP ${resp.status}`, true); return; }
    state.sessionId = data.sessionId;
    state.cwd = data.cwd;
    state.workspace = workspace;
    rememberActive();
    renderSessionChip();
    renderSessionList();
    clearStream(`session ${data.sessionId.slice(0, 8)} started in ${data.cwd}`);
    toast("session started");
  } catch (e) {
    toast(`session start failed: ${e.message}`, true);
  }
}

$("#new-session").addEventListener("click", () => startSession(state.workspace ?? sessionsList()[0]?.workspace));

// ---------------------------------------------------------------- stream
const stream = $("#stream");

function clearStream(msg) {
  stream.replaceChildren(msg ? el("p", "muted", msg) : "");
}

function autoScroll() { stream.scrollTop = stream.scrollHeight; }

function appendUser(text) {
  stream.append(el("div", "user-echo", `❯ ${text}`));
  autoScroll();
}

function appendError(msg) {
  stream.append(el("div", "errbox", `⚠ ${msg}`));
  autoScroll();
}

function br(streamState) {
  if (streamState.needNl) {
    stream.append(document.createElement("br"));
    streamState.needNl = false;
  }
}

function renderTodoPanel(parent, todos) {
  const icons = { completed: "✓", in_progress: "▸", blocked: "!", abandoned: "⊘", pending: "○" };
  const d = el("div", "todos");
  d.append(el("div", null, "☰ todos"));
  for (const t of todos) {
    d.append(el("div", "item", `  ${icons[t.status] ?? "○"} ${t.content ?? ""}${t.blocker ? ` (blocked: ${t.blocker})` : ""}`));
  }
  parent.append(d);
  autoScroll();
}

function handleFrame(frame, parts) {
  let evName = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) evName = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  let ev;
  try { ev = JSON.parse(dataLines.join("\n")); } catch { return; }
  if (evName === "error") { appendError(`omp error: ${extractText(ev)}`); parts.failed = true; return; }
  if (evName === "done") { parts.done = true; return; }
  if (typeof ev !== "object") return;

  const etype = ev.type ?? "";
  const sub = etype === "message_update" ? (ev.assistantMessageEvent ?? {}) : {};
  const kind = sub.type ?? "";

  if (parts.mode === "quiet") {
    if (kind === "text_delta") {
      if (!parts.answer.isConnected) stream.append(parts.answer);
      parts.answer.append(document.createTextNode(sub.delta ?? ""));
      parts.needNl = true;
      autoScroll();
    }
    return;
  }

  if (kind === "thinking_start") {
    br(parts);
    stream.append(el("div", "thinking-head", "── thinking ──"));
    parts.thinkingBody = el("div", "thinking");
    stream.append(parts.thinkingBody);
  } else if (kind === "thinking_delta") {
    parts.thinkingBody?.append(document.createTextNode(sub.delta ?? ""));
    parts.needNl = true;
    autoScroll();
  } else if (kind === "thinking_end") {
    br(parts);
  } else if (kind === "text_delta") {
    if (!parts.answer.isConnected) stream.append(parts.answer);
    parts.answer.append(document.createTextNode(sub.delta ?? ""));
    parts.needNl = true;
    autoScroll();
  } else if (etype === "tool_execution_start") {
    br(parts);
    const card = el("div", "tool");
    const head = el("div", "head");
    head.append(el("span", null, "● " + (ev.toolName ?? "?")));
    const arg = ev.args?.i ?? ev.args?.command ?? ev.args?.path ?? ev.args?.file_path ?? "";
    if (arg) head.append(el("span", "arg", "  " + clip(String(arg), 120)));
    card.append(head);
    stream.append(card);
    parts.tools[ev.toolCallId] = { card, budget: 2000, printed: false };
    autoScroll();
  } else if (etype === "tool_execution_update") {
    const t = parts.tools[ev.toolCallId];
    if (!t || t.budget <= 0) return;
    const text = clip(extractText(ev.partialResult), Math.min(500, t.budget));
    if (!text) return;
    t.budget -= text.length;
    t.printed = true;
    for (const ln of text.split("\n")) t.card.append(el("div", "out", "│ " + ln.slice(0, 120)));
    autoScroll();
  } else if (etype === "tool_execution_end") {
    const t = parts.tools[ev.toolCallId];
    if (!t) return;
    if (t.budget <= 0) t.card.append(el("div", "out", "… output truncated"));
    if (ev.isError) t.card.append(el("div", "err", "✗ " + clip(extractText(ev.result), 300)));
    else if (t.printed) t.card.append(el("div", "ok", "✓ done"));
    delete parts.tools[ev.toolCallId];
    autoScroll();
  } else if (etype === "todo_reminder") {
    br(parts);
    renderTodoPanel(stream, ev.todos ?? []);
  } else if (etype === "todo_auto_clear") {
    stream.append(el("div", "sys", "— todo list cleared"));
  } else if (etype === "notice") {
    br(parts);
    const icons = { info: "ℹ", warning: "⚠", error: "✗" };
    stream.append(el("div", "sys" + (ev.level === "error" ? " err" : ev.level === "warning" ? " warn" : ""), `${icons[ev.level] ?? "ℹ"} ${ev.message ?? ""}`));
    autoScroll();
  } else if (etype === "auto_retry_start") {
    br(parts);
    stream.append(el("div", "sys warn", `↻ retry ${ev.attempt}/${ev.maxAttempts} in ${Math.round((ev.delayMs ?? 0) / 1000)}s — ${clip(ev.errorMessage ?? "", 160)}`));
    autoScroll();
  } else if (etype === "auto_retry_end") {
    stream.append(el("div", ev.success ? "sys" : "sys err", ev.success ? "↻ retry succeeded" : "↻ retry failed: " + clip(ev.finalError ?? "", 200)));
  } else if (etype === "auto_compaction_start") {
    br(parts);
    stream.append(el("div", "sys", `⧉ compacting context (${ev.action ?? ""})…`));
  } else if (etype === "auto_compaction_end") {
    const st = ev.aborted ? "aborted" : ev.skipped ? "skipped" : "done";
    stream.append(el("div", "sys", `⧉ compaction ${st}`));
  } else if (etype === "retry_fallback_applied") {
    stream.append(el("div", "sys warn", `→ model fallback: ${ev.from} → ${ev.to}`));
  }
}

function setBusy(busy) {
  state.busy = busy;
  $("#send").disabled = busy;
  $("#abort").classList.toggle("hidden", !busy);
  $("#steer-row").classList.toggle("hidden", !busy);
}

function promptFetch(sessionId, text) {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function recoverSession() {
  // wrapper lost the session (restart/redeploy): resume from the persisted
  // transcript, or fall back to a fresh session in the same workspace
  const st = JSON.parse(localStorage.getItem(LS_ACTIVE) ?? "{}");
  if (st.sessionFile && st.cwd) {
    const { resp, data } = await jfetch("/api/sessions", { method: "POST", body: { resume: st.sessionFile, cwd: st.cwd } }, 30000);
    if (resp.ok) {
      state.sessionId = data.sessionId;
      state.cwd = data.cwd;
      rememberActive();
      renderSessionChip();
      return data;
    }
  }
  if (state.workspace) {
    const { resp, data } = await jfetch("/api/sessions", { method: "POST", body: { cwd: `/workspaces/${state.workspace}` } }, 30000);
    if (resp.ok) {
      state.sessionId = data.sessionId;
      state.cwd = data.cwd;
      rememberActive();
      renderSessionChip();
      return data;
    }
  }
  return null;
}

async function sendPrompt() {
  const text = $("#prompt").value.trim();
  if (!text) return;
  if (!state.sessionId) { toast("start or select a session first", true); return; }
  if (state.busy) return;
  $("#prompt").value = "";
  appendUser(text);
  setBusy(true);

  const parts = {
    mode: "full",
    answer: el("div", "answer"),
    tools: {},
    thinkingBody: null,
    needNl: false,
    done: false,
    failed: false,
  };
  try {
    let resp = await promptFetch(state.sessionId, text);
    if (resp.status === 404) {
      const rec = await recoverSession();
      if (!rec) {
        toast("session no longer exists — start a new one from the sidebar", true);
        setBusy(false);
        return;
      }
      stream.append(el("div", "sys", `server session was gone — resumed as ${state.sessionId.slice(0, 8)} (${state.cwd ?? "default workspace"})`));
      resp = await promptFetch(state.sessionId, text);
      if (resp.status === 404) {
        toast("could not recover the session — start a new one from the sidebar", true);
        setBusy(false);
        return;
      }
    }
    if (resp.status === 409) { toast("session busy — abort first", true); return; }
    if (resp.status === 401) { showLogin(); return; }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (frame.trim()) handleFrame(frame, parts);
        if (parts.done || parts.failed) break;
      }
      if (parts.done || parts.failed) break;
    }
    br(parts);
    if (parts.failed) toast("turn failed — see the stream", true);
  } catch (err) {
    appendError(`stream failed: ${err.message}`);
    toast(`prompt failed: ${err.message}`, true);
  } finally {
    setBusy(false);
    autoScroll();
  }
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  void sendPrompt();
});

$("#steer-row").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#steer-input").value.trim();
  if (!text || !state.sessionId) return;
  $("#steer-input").value = "";
  try {
    const { resp, data } = await jfetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/steer`, { method: "POST", body: { text } });
    if (!resp.ok) toast(data?.error?.message ?? `HTTP ${resp.status}`, true);
    else toast("steered");
  } catch (err) {
    toast(`steer failed: ${err.message}`, true);
  }
});

$("#abort").addEventListener("click", async () => {
  if (!state.sessionId) return;
  try {
    const { resp } = await jfetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/abort`, { method: "POST" });
    if (!resp.ok) toast(`abort failed (HTTP ${resp.status})`, true);
  } catch (err) {
    toast(`abort failed: ${err.message}`, true);
  }
});

// ---------------------------------------------------------------- go
(async function init() {
  try {
    const { resp } = await jfetch("/api/health", {}, 8000);
    if (resp.status === 401) return showLogin();
  } catch (e) {
    toast(`ui backend unreachable: ${e.message}`, true);
  }
  boot();
})();
