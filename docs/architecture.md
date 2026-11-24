# Architecture

How v0.4.0 works inside, and why it is built this way. For behavior and defaults, see the [Reference](reference.md).

## Overview

```
┌──────────────────────── manager pi (interactive, or RPC host such as pi-web) ─────────────────────────┐
│ extensions/multi-agent/index.ts                                                                       │
│   Registry (Map name → Worker, "change" events)                                                       │
│   tools: worker_spawn/send/wait/status/stop     commands: /workers /worker-send /worker-stop …        │
│   WorkerHost: forwards worker dialogs to ctx.ui  ·  onSettled → pi.sendMessage (auto-notify)          │
│   UI: widget (ui.ts) · viewer (ui.ts) · 1 s ticker · throttled refresh                                │
│                                                                                                       │
│   Worker (worker.ts) ×N ── stdin: JSONL commands ──►  pi --mode rpc --name worker:<name> …            │
│                         ◄─ stdout: responses + events + extension_ui_request                          │
│                         ◄─ stderr: diagnostics                                                        │
│        │ writes                                                                                       │
│        ▼                                                                                              │
│   runs/<run>/<name>.log · .events.jsonl · .result.md · .stderr.log · .role.md                         │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
                    each worker pi also persists its own session file (worker:<name>)
```

| File | Responsibility |
|---|---|
| `index.ts` | Extension entry: registry, tools, commands, message renderer, dialog forwarding, auto-notify, wait loop, widget plumbing, session lifecycle |
| `worker.ts` | One worker process: spawn, strict JSONL RPC client, event → state mapping, transcript, log files, shutdown escalation |
| `ui.ts` | Widget component / plain lines, and the `/workers` viewer component |
| `format.ts` | Shared text formatting (status lines, reports, numbers) |

## Process model

A worker is started as a child process running pi's own CLI:

- **Launch:** `process.execPath` with `process.argv[1]` (pi's CLI script) when that file exists. Bun-compiled pi binaries
  launch themselves, and the fallback is `pi` on `PATH`. This is the same strategy as pi's bundled subagent example.
  It runs the same pi version as the manager, without depending on `PATH`.
- **Arguments:** `--mode rpc --name worker:<name>`, then optionally `--model`, `--thinking`, `--tools`,
  `--append-system-prompt <run>/<name>.role.md`, then `PI_MULTI_AGENT_WORKER_ARGS`.
- **Environment:** inherits the manager's, plus `PI_MULTI_AGENT_ROLE=worker` and `PI_MULTI_AGENT_WORKER=<name>`.
  The extension returns early when `PI_MULTI_AGENT_ROLE=worker`, so workers never get the worker tools. This prevents
  recursive spawning.
- **cwd:** the manager's cwd, or the `cwd` parameter.

Workers load the user's settings, packages, skills and context files like any pi. That is intentional: a worker is a
full pi.

## RPC protocol usage

`Worker` implements its own minimal client instead of pi's exported `RpcClient`, for two reasons:

1. `RpcClient` copies child stderr to `process.stderr`. Inside an interactive manager, that would corrupt the TUI.
2. `RpcClient` spawns `node` from `PATH`. We want the manager's own runtime and CLI path (see above).

Framing is strict JSONL: a `StringDecoder` handles multi-byte boundaries, records are split on `\n` only, and an
optional trailing `\r` is stripped. Unlike Node's `readline`, U+2028/U+2029 inside JSON strings are not treated as line
breaks. Stdout is always consumed, so the child never blocks on a full pipe.

Commands are correlated by `id` (`ma-1`, `ma-2`, …) with per-command timeouts:

| Command | Used for | Timeout |
|---|---|---|
| `get_state` | startup handshake; session file/id, resolved model, thinking level | 120 s |
| `prompt` | new task (idle worker) | 60 s for acceptance |
| `steer` / `follow_up` | messages while busy | 60 s |
| `abort` | abort the current task (responds once idle) | 30 s (5 s during shutdown) |

A `prompt` response only means "accepted". Completion is signaled by the `agent_settled` event. If the response's
`disposition` is `handled` (an extension command consumed it), no run starts and the worker returns to idle.

### Event → state mapping

| Event | Effect on `Worker` |
|---|---|
| `agent_start` | `busy = true`, status `running` |
| `turn_start` | `turns++`, activity `waiting for model`, log `── turn N ──` |
| `message_start` (assistant) | reset per-message stream tracking |
| `message_update` `thinking_start/delta/end` | stream into a `thinking` transcript entry, `thinkingTail`, log `┊`; the `_end` content is authoritative |
| `message_update` `text_start/delta/end` | stream into a `text` entry, log `│` |
| `message_update` `toolcall_start` | activity `calling <tool>` |
| `message_end` (assistant) | add usage and cost, record the stop reason and errors; backfill thinking/text blocks the provider did not stream; update `lastText` |
| `tool_execution_start` | `toolCalls++`, activity `<tool> <args summary>`, `tool` entry |
| `tool_execution_end` | `toolErrors++` on error, `toolResult` entry (first lines), duration |
| `queue_update` | `queued` = pending steer + follow-up count |
| `auto_retry_start/end`, `compaction_start/end` | activity + `info`/`error` entries |
| `agent_settled` | `busy = false`; status `idle` / `error` / `aborted`; `result = lastText`; write `<name>.result.md`; emit `settled` |
| process `close` | if not stopping: status `crashed` with the exit reason and stderr tail; reject pending commands; emit `settled` if it was busy |

`extension_ui_request` records are handled separately. `select`/`confirm`/`input`/`editor` are forwarded to the
manager's UI via `WorkerHost.dialog` and answered with `extension_ui_response`; the call waits on the user, and there is
no timeout unless the worker set one. `notify` goes to the transcript, and only warnings and errors also reach the
manager UI. `setStatus`, `setWidget`, `setTitle` and `set_editor_text` are ignored.

## Worker state machine

```
                spawn                get_state ok
   (new) ─────────────► starting ────────────────► idle ◄──────────────┐
                           │                         │ prompt          │ agent_settled
                           │ start fails / timeout   ▼                 │ (ok → idle,
                           │                      running ─────────────┤  error → error,
                           ▼                         │ steer/followUp  │  aborted → aborted)
                 stopped (or crashed,                │ (stays running) │
                 if it already exited)               │                 │
                                                     │                 │
   error / aborted ──── prompt ────────────────────► running           │

   any state ── stop() ──────────► stopped     (intentional exit)
   any state ── unexpected exit ─► crashed     (exit reason + stderr tail)
```

`busy` is the authoritative "working" flag. It is set **synchronously before** `prompt` is sent, so a
`worker_wait` issued right after `worker_spawn` can never see a false "done". It is cleared by `agent_settled`, a
`handled` disposition, a rejected prompt, or process exit.

## Results and notification

- **Result** = text of the last assistant message with text content during the task (`lastText` at `agent_settled`).
  Thinking and tool output are not part of the result.
- **`reported`** tracks whether the current task's result has reached the manager LLM:
  - reset to `false` by `prompt` and by `send` (new information is coming);
  - set to `true` by `worker_wait` results, by the `worker_stop` tool, by any kill, by shutdown, and by an
    auto-notification. Aborts you trigger yourself (viewer `a`, `/worker-stop <name>` without `kill`) leave it `false`,
    so the manager is told that its worker was aborted.
- **User toast** (`onSettled`), when a worker settles and is not `stopping`: `ctx.ui.notify("Worker <name> <status>")`,
  `info` for done and `warning` otherwise. This shows at once, even while the manager is in a turn.
- **Auto-notify** (`onSettled`), when a worker settles: skip if it is `stopping`, already `reported`, or has `notify`
  set to `false`, **or if any `worker_wait` call is currently waiting on it** (tracked with a per-name waiter count).
  Otherwise it calls `pi.sendMessage({customType: "multi-agent", …}, {deliverAs: "followUp", triggerTurn: true})`.
  An idle manager starts a turn right away. A busy manager gets the message after its current run.
- **Waiting** is a 400 ms poll of `busy` across the target workers, with an abort-aware sleep and a progress update
  at most once per second. Each poll also checks `ctx.hasPendingMessages()`. If the user queued a steer or
  follow-up message, the wait returns `interrupted`. Pi delivers a steer message only after the current tool call
  ends, so without this check a user message waited up to the full timeout (1800 s).
- **Manager prompting.** The `worker_spawn` guidelines tell the manager to end its turn after a spawn, and to call
  `worker_wait` only when the user asks. The manager then stays free to talk, and results come by auto-notify. Polling the authoritative flag is simpler and more robust than coordinating
  one-shot events: a `settled` that fires before the waiter subscribes cannot be missed.

## UI

- **Widget.** In TUI mode, a component factory is registered once. Its `render()` reads live registry state, and
  updates are just `tui.requestRender()` (throttled to 100 ms). In other modes with a UI (RPC hosts), only string
  arrays are supported, so the plain lines are re-sent at most once per second. A 1 s ticker emits `change` while any
  worker is busy, so elapsed times keep moving. The widget is cleared while the viewer is open, and whenever there
  are no workers.
- **Viewer.** A `ctx.ui.custom()` component. It renders only the tail it needs: it walks transcript entries from
  the end until the viewport plus scroll offset is filled. Each entry's wrapped lines are cached in a `WeakMap` keyed
  by the entry and invalidated by text length or width, so streaming re-wraps only the entry that grows. Registry
  changes trigger renders, throttled to 80 ms. Actions that need dialogs (message, kill-confirm) close the viewer
  with an action value. The command handler then runs the dialog and reopens the viewer on the same worker.
- **Tool rows.** Custom `renderCall` shows the worker name and task. `renderResult` shows the first 12 lines
  collapsed, and everything when expanded. Auto-notifications have a message renderer (`⚑ worker <name> <status>`, 8
  lines collapsed).

## Files and logging

- `<name>.log` is the human-readable stream, written as events arrive (deltas included), so `tail -f` is live.
- `<name>.events.jsonl` is compact by design. Streaming deltas are dropped, and payloads that repeat other records are
  reduced: `agent_end` messages, `turn_end` message, `message_start`, and the system prompt. The session file is the
  complete record. Before this was in place, a 2-turn task produced ~40 KB; after, a 3-task worker produced ~14 KB.
- `<name>.result.md` is rewritten on every settle.

## Shutdown

`session_shutdown` (quit, `/new`, `/resume`, `/fork`, `/reload`) stops all workers in parallel, then clears the
registry and widget. `Worker.stop()` escalates step by step:

1. `abort` if busy (≤ 5 s)
2. close stdin; pi's orderly shutdown (≤ 3 s)
3. `SIGTERM` (≤ 2 s)
4. second `SIGTERM`: pi exits immediately (≤ 2 s)
5. `SIGKILL`

If the manager process dies without running this, the workers' stdin closes and pi shuts them down on its own.

## Design decisions

| Decision | Why | Alternative considered |
|---|---|---|
| Long-lived `--mode rpc` workers | steer, follow-ups, persistent context, live status, abort without killing | one-shot `--mode json -p` (pi's subagent example): simpler, but fire-and-forget, with no thinking stream in its UI and no transcript (`--no-session`) |
| Own RPC client | stderr must not reach the TUI; use the manager's runtime and CLI | exported `RpcClient` |
| Persist worker sessions by default | full transcript with thinking, viewable in pi and pi-web | `--no-session` (still available through `PI_MULTI_AGENT_WORKER_ARGS`) |
| Auto-notify with `followUp` + `triggerTurn` | the manager can fire and forget; results are never lost | only `worker_wait` (forces the manager to block) |
| Polling wait | robust, no missed-event races, trivial to cancel | event-driven promises |
| Do not wait by default; interrupt a wait on user input | the user can always talk to the manager and steer workers through it | wait by default (v0.1.0): blocked the user for up to 30 min |
| Recursion guard through an env var | workers load the same packages | process-tree depth tracking |
| Logs outside the repo (`~/.pi/agent/multi-agent`) | no pollution of projects or git status | `<cwd>/.pi/…` |
| Tools allowlist + role prompt, no sandbox | matches pi's own model; simple | containers / worktrees (roadmap) |

## Security notes

- Workers run with the same OS permissions as the manager. The `tools` allowlist restricts which tools the model
  can call; it is not a sandbox (`bash` can do anything).
- Workers load the user's global packages and the project's trusted resources, like any pi in that directory.
- Task and role text is written to the logs and session files in plain text.
- Dialogs raised inside workers (e.g. permission gates) are forwarded to you rather than auto-approved. Without a
  UI they are cancelled (fail closed).

## pi APIs this depends on

If a pi upgrade changes any of these, re-run the smoke tests in the [Runbook](../RUNBOOK.md#smoke-tests):

- CLI: `--mode rpc`, `--name`, `--model`, `--thinking`, `--tools`, `--append-system-prompt`
- RPC: `get_state`, `prompt`, `steer`, `follow_up`, `abort`, `extension_ui_request/response`, the JSON event stream
  (`agent_settled`, `message_update` sub-events, `tool_execution_*`, `queue_update`, `auto_retry_*`, `compaction_*`)
- Extension API: `registerTool` (`renderCall`/`renderResult`, `promptSnippet`/`promptGuidelines`), `registerCommand`,
  `registerMessageRenderer`, `sendMessage` (`deliverAs`, `triggerTurn`), `ctx.ui.setWidget` (factory and string
  forms), `ctx.ui.custom`, dialogs, `session_start`/`session_shutdown`, `getAgentDir`, `truncateHead`
- pi-tui: `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`, `matchesKey`, `Text`
