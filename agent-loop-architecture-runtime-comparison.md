# Agent Loop, Architecture & Core Runtime: Pi vs OpenCode vs Claude Code

Deep-dive companion to the harness comparison. Focus: **how each harness actually runs the agent loop**, how its **architecture** is structured, and where the **core runtimes** genuinely differ. Evidence-first; links inline. State current as of 2026-09; these products ship weekly.

**Note on naming:** "Pi" here means **omp** ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)), a fork of Mario Zechner's [pi-mono](https://github.com/badlogic/pi-mono). OpenCode refers to [anomalyco/opencode](https://github.com/anomalyco/opencode) (formerly under the `sst` org).

---

## 1. The agent loop

All three share the same skeleton: **prompt → model stream → tool calls → tool results → repeat until the model stops**. The differences are in what wraps that skeleton: retry/recovery policy, context management, injected observers, and where the approval gate sits.

### Pi (omp): loop with self-healing and in-loop observers

- **Core loop** lives in `packages/agent` (`pi-agent-core`); sessions/turns are orchestrated by `AgentSession` in `packages/coding-agent`. Same loop powers all four surfaces (TUI, one-shot `-p`, SDK, RPC/ACP) — see the [README entry-points section](https://github.com/can1357/oh-my-pi#four-entry-points).
- **Recovery is a first-class subsystem.** `TurnRecovery` ([docs/non-compaction-retry-policy.md](https://github.com/can1357/oh-my-pi/blob/main/docs/non-compaction-retry-policy.md)) classifies failed turns (rate limits, 5xx, transport failures, provider refusals, HTTP/2 stream resets) and retries with backoff, **credential rotation**, and **model fallback** (`confirm` / `auto` / `fail-closed` usage-aware policies). Retries are **replay-safe**: a turn with already-emitted visible output or completed tool calls is preserved-and-continued rather than re-sent, so side effects don't replay.
- **Compaction is multi-trigger** ([docs/compaction.md](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md)): manual `/compact`, overflow-error recovery, `stopReason: "length"` recovery, post-turn threshold maintenance, **mid-turn** maintenance (before the next provider request inside a long tool loop), and idle maintenance. Compaction is a first-class session entry (`CompactionEntry` with a `firstKeptEntryId` boundary), and one strategy archives history as **dense bitmap images** (`snapcompact`) instead of prose summaries.
- **Stream rules abort mid-token**: a regex on the outgoing stream aborts the request, injects the rule as a system reminder, and retries from the same point ("time-traveling stream rules", [README](https://github.com/can1357/oh-my-pi#04--time-traveling-stream-rules)). Injections survive compaction.
- **An advisor model watches the loop**: a second model in the `advisor` role reads every turn on its own context and injects notes/concerns/blockers inline ([docs/advisor-watchdog.md](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md)).
- **Eval kernels re-enter the loop**: persistent Python/JS cells can call the agent's own tools (read, grep, task) over a loopback bridge — tool execution is not a dead end ([README](https://github.com/can1357/oh-my-pi#01--code-execution-w-tool-calling)).
- **Approval tiers (`read`/`write`/`exec`) are evaluated per tool call inside the loop**, with tool-declared policies and user overrides resolved by a fixed precedence ([docs/approval-mode.md](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md)). Default mode is `yolo` (auto-approve everything).

### OpenCode: loop runs in a server; clients are thin

- **The loop does not live in the UI.** Running `opencode` starts a **local HTTP server** plus a TUI that is just a client ([docs/server](https://opencode.ai/docs/server/)). `POST /session/:id/message` sends a prompt and the server drives the loop; clients watch via SSE (`GET /global/event`). `opencode serve` runs the server headless.
- **Everything is an API**: fork, revert/unrevert, share, summarize (manual compaction), permission responses (`POST /session/:id/permissions/:permissionID`) are server endpoints — the approval prompt is a client round-trip, which is how the desktop app and IDE plugins share one engine.
- **Model access goes through the Vercel AI SDK** with provider metadata from models.dev — 75+ providers ([docs/providers](https://opencode.ai/docs/providers/)). Provider quirks are therefore as good as the AI SDK's normalization.
- **Loop guards are simpler**: a `doom_loop` permission triggers when the same tool call repeats 3× with identical input ([docs/permissions](https://opencode.ai/docs/permissions/)); the built-in **plan/build agents** swap loop behavior (plan denies edits and asks before bash). Summarization exists as an endpoint but there is no documented multi-trigger, mid-turn compaction machinery comparable to Pi's.

### Claude Code: loop wrapped in gates and a classifier

- **Single local process drives the loop** (terminal, VS Code, JetBrains embed the same engine; the desktop app bundles it; web/mobile run **cloud sessions** where the loop executes on Anthropic infrastructure — [overview](https://code.claude.com/docs/en/overview)).
- **Every tool call passes a permission gate first**: six modes (`default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`), plus `PreToolUse` hooks that can allow/deny programmatically ([permission modes](https://code.claude.com/docs/en/permission-modes)).
- **Auto mode puts a second model in the loop**: a classifier reviews each action before it runs, blocking escalation, unrecognized-infrastructure access, or prompt-injection-driven actions — including messages Claude sends to other agents ([permission modes](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode)).
- **Plan mode restructures the loop**: edits are blocked until a plan is approved; the loop is explicitly explore-then-execute.
- **Subagents** (Task tool) run their own loops with their own context and tool allowlists; **auto memory** and `CLAUDE.md` seed context each session.

### Loop differences at a glance

| Aspect | Pi (omp) | OpenCode | Claude Code |
|---|---|---|---|
| Where the loop runs | In-process (same engine as UI) | **Server process**; UI is an HTTP/SSE client | Local CLI process; cloud sessions on Anthropic infra |
| Failure recovery | Typed retry classifier, replay-safe resume, credential rotation, model fallback chains | Server `abort` endpoint; provider-level retries via AI SDK | Mode-dependent; classifier + hooks mediate; no published equivalent of Pi's preserve-and-continue engine |
| Context management | 6-trigger compaction incl. mid-turn; bitmap (`snapcompact`) strategy; compaction as session entry | `/summarize` endpoint; simpler threshold behavior | Auto-compact + `/compact`; auto memory across sessions |
| In-loop observers | Advisor model per turn; stream-rule injection w/ mid-token abort | None documented | Auto-mode classifier per action; PreToolUse/PostToolUse hooks |
| Edit machinery | `hashline` patches (content-hash anchors, stale-anchor rejection), `ast_edit` staged-then-accepted | str_replace-style edit | str_replace-style `Edit` tool |
| Guard rails in-loop | Approval tiers per call; `doom_loop`-style repetition is Pi-adjacent via tool policy, not built-in | `doom_loop` (3× identical call → permission) | Ask rules, protected paths, critical-path `rm` checks even in bypass mode |

---

## 2. Architecture

### Pi: single process, many faces

One Bun process contains the engine; TUI, `omp -p`, the Node SDK, NDJSON RPC (`--mode rpc`), and ACP (`omp acp`, for Zed/editors) are **modes of the same runtime**, not separate builds ([README](https://github.com/can1357/oh-my-pi#four-entry-points)). Subagents fan out inside the same process (optionally into **worktree-isolated** copies via `pi-iso` — APFS clones, btrfs/zfs reflinks, overlayfs). Trade-off: lowest integration friction, but engine and UI share fate (a crash takes both).

### OpenCode: client/server, OpenAPI-first

The server owns sessions, providers, LSP, MCP, and the loop; the OpenAPI 3.1 spec at `/doc` **generates the SDKs** ([docs/server](https://opencode.ai/docs/server/)). TUI, desktop app, and IDE plugins are all clients; `--hostname/--port` lets multiple clients attach to one server. Trade-off: best multi-client story and headless embedding, at the cost of a local network hop and a server lifecycle to manage.

### Claude Code: CLI engine + cloud split

The engine ships as a native binary; IDE extensions drive it; the desktop app wraps it; **web/mobile sessions execute on cloud infrastructure** with repo access granted through GitHub connections ([overview](https://code.claude.com/docs/en/overview)). The **Agent SDK** embeds the engine in your Node process. Trade-off: most deployment variety (local ↔ cloud ↔ scheduled routines), but the engine itself is closed — architecture is observable only through documented surfaces.

| | Pi | OpenCode | Claude Code |
|---|---|---|---|
| Process model | Single multi-mode process | Client/server (local HTTP + SSE) | Local binary + managed cloud runners |
| Embedding | Node SDK, NDJSON RPC, ACP | Generated SDKs from OpenAPI spec | Agent SDK |
| Editor integration | ACP (Zed) | IDE plugins via `/tui` control endpoints | VS Code + JetBrains extensions |
| Remote/headless | RPC mode; `--no-session` | `opencode serve` (first-class) | `-p` headless; web/cloud sessions |

---

## 3. Harness layer

**Tools.** Pi ships 31 built-ins including LSP (14 ops), a DAP debugger client (28 ops), browser (Puppeteer/CDP/relay), desktop control, AST edit/query, and 23-provider web search ([README tools section](https://github.com/can1357/oh-my-pi#whatever-the-task-needs-its-already-in-the-box)). OpenCode covers file ops, bash, web fetch/search, LSP diagnostics (opt-in, [docs/lsp](https://opencode.ai/docs/lsp/)), MCP, formatters — no debugger or browser integration documented. Claude Code has a tight core (Read/Edit/Bash/WebFetch…), MCP, Chrome integration, and cloud-side tools (GitHub Actions review, Slack) — no LSP, no DAP.

**Permissions.** Pi: 3-tier approvals + per-tool policy overrides + bash critical-pattern overrides, **default `yolo`**, explicitly *not* OS containment ([approval-mode.md](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md)). OpenCode: `allow/ask/deny` pattern rules with external-directory gating, permissive defaults, `.env` read-deny ([permissions](https://opencode.ai/docs/permissions/)). Claude Code: permission modes + rules + **OS-enforced sandbox** (macOS Seatbelt, Linux bubblewrap + socat network proxy), credential masking, org-managed settings ([sandboxing](https://code.claude.com/docs/en/sandboxing)). Only Claude Code enforces containment below the permission layer; if you run Pi or OpenCode on untrusted repos, bring your own container.

**Extensibility.** Pi extensions are TypeScript modules sharing the same tool/slash-command/TUI APIs as built-ins, plus skills, hooks, marketplaces, and schema-validated subagents. OpenCode: JS/TS plugins, custom agents/commands/tools, MCP, skills. Claude Code: hooks, skills, subagents, MCP, Agent SDK — extension surface is broad but bounded by the closed core.

---

## 4. Core runtime

| | Pi | OpenCode | Claude Code |
|---|---|---|---|
| Language/runtime | TypeScript on **Bun** + **Rust natives** (~80k LoC across 6 crates) | TypeScript on Bun | Native binary (ripgrep bundled) |
| Search/glob/shell | In-process: ripgrep-linked grep, parallel walker w/ scan cache (`pi-walker`), **embedded bash** (`pi-shell`, a vendored brush fork) + 58 ported coreutils — zero fork/exec on the hot path ([README](https://github.com/can1357/oh-my-pi#roughly-80000-lines-of-rust-doing-the-work-other-harnesses-shell-out-for)) | Shells out to system tools; AI SDK for models | Bundled ripgrep; Bash tool spawns real processes |
| Model-policy location | Compiled **KDL rule tree** (`rules.json`) — no model-name string matching in TS ([compat rules](https://github.com/can1357/oh-my-pi/tree/main/packages/catalog/src/compat/rules)) | AI SDK normalization + models.dev metadata | Closed core; per-model behavior managed by Anthropic |
| Worktree isolation | `pi-iso`: APFS clones, btrfs/zfs reflinks, overlayfs, projfs | Not documented | Git worktrees (user-managed); sandbox-runtime containers |
| Platforms | macOS/Linux/Windows (incl. Windows ARM64), x64+ARM64, musl; native on Windows without WSL | macOS/Linux/Windows (Windows via choco/scoop; Bun support in progress) | macOS/Linux/WSL2/native Windows (sandbox requires WSL2 on Windows) |
| Packaging | npm, Homebrew, install script, Nix flake (+Home Manager module), mise, compiled binaries | npm, Homebrew, pacman, choco/scoop, Docker, Nix | Native installer, Homebrew cask, WinGet, apt/dnf/apk, desktop apps |

**What the runtime differences buy you:** Pi's in-process native layer removes fork/exec from every grep/shell/AST call and makes the same binary fully native on Windows — the practical effect is fast cold search and no dependency on a POSIX toolchain. OpenCode's thin-runtime approach maximizes portability and community porting but inherits OS tool variability. Claude Code's bundled-tool approach trades binary size for deterministic behavior across machines, and its sandbox runtime (Seatbelt/bubblewrap) is the only one enforcing isolation at the OS layer rather than asking nicely.

---

## 5. Practical consequences

- **Same model, different results**: Pi's whole thesis is that edit-format and prompt shaping change outcomes per model (self-reported: Grok Code Fast 6.7%→68.3% pass-rate lift on its diff format, [blog](https://blog.can.ac/2026/02/12/the-harness-problem/)); OpenCode's AI-SDK neutrality means less per-model tuning; Claude Code's loop is tuned for Claude models (auto mode requires specific Claude versions, [permission modes](https://code.claude.com/docs/en/permission-modes)).
- **Long sessions**: Pi's mid-turn compaction and preserve-and-continue recovery are the most aggressive context/reliability engineering of the three; OpenCode leans on server sessions + summarize; Claude Code on auto-compact + memory.
- **Unattended runs**: Claude Code is the only one with in-loop autonomous safety (classifier) *and* OS containment; Pi/OpenCode need external sandboxing for untrusted input.
- **Programmatic embedding**: OpenCode's OpenAPI server and Pi's RPC/SDK are both strong; Claude Code's Agent SDK is capable but proprietary.

## 6. References

- Pi: [repo](https://github.com/can1357/oh-my-pi) · [approval-mode.md](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md) · [compaction.md](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md) · [non-compaction-retry-policy.md](https://github.com/can1357/oh-my-pi/blob/main/docs/non-compaction-retry-policy.md) · [advisor-watchdog.md](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md) · [upstream pi-mono](https://github.com/badlogic/pi-mono)
- OpenCode: [docs](https://opencode.ai/docs/) · [server](https://opencode.ai/docs/server/) · [permissions](https://opencode.ai/docs/permissions/) · [providers](https://opencode.ai/docs/providers/) · [LSP](https://opencode.ai/docs/lsp/) · [repo](https://github.com/anomalyco/opencode)
- Claude Code: [overview](https://code.claude.com/docs/en/overview) · [permission modes](https://code.claude.com/docs/en/permission-modes) · [sandboxing](https://code.claude.com/docs/en/sandboxing) · [pricing](https://claude.com/pricing)
- Pi harness benchmark (self-reported): [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
