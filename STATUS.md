# Status & Progress

| | |
|---|---|
| **Version** | 0.1.0 |
| **State** | 🟢 Working prototype. The core flows are verified end-to-end by hand. There is no automated test suite yet |
| **Last updated** | 2026-11-24 |
| **Tested on** | macOS (Darwin 27.2), pi 1.6.0, Node v26.2.0, tmux 3.8; models `claude-code/default` |

## Component status

| Area | Status | Notes |
|---|---|---|
| Worker RPC layer (`worker.ts`) | ✅ Done · verified | Spawn, handshake, tasks, events → state, logs, abort, crash detection, shutdown |
| Manager tools | ✅ Done · mostly verified | `worker_spawn`, `worker_wait`, `worker_status` used by a real manager LLM. `worker_send` was verified for idle workers only. `worker_stop` was not driven by an LLM yet (its underlying abort/stop is verified) |
| Auto-notify | ✅ Done · verified | The result is delivered and the manager reacts on its own |
| Widget | ✅ Done · verified | TUI component and plain-text lines for RPC hosts |
| `/workers` viewer | ✅ Done · verified | Rendering, scrolling, switching, `m` message. The `a`/`k` keys were not exercised |
| Slash commands | ⚠️ Partly verified | `/workers` verified; `/worker-send`, `/worker-stop` and `/workers-clear` not exercised |
| Logs, result files, event log | ✅ Done · verified | Event log compaction verified (40 KB → 14 KB) |
| Dialog forwarding from workers | ⚠️ Implemented, untested | No extension raised a dialog during testing |
| Documentation | ✅ Done | README, RUNBOOK, STATUS, docs/ |
| Automated tests | ❌ Not started | See roadmap |
| Type checking | ❌ Not set up | pi loads the TypeScript through jiti, which strips types without checking them |

## Verification log

All runs were on 2026-11-24. Procedures for repeating them are in the [Runbook](RUNBOOK.md#smoke-tests).

| ID | What | How | Result |
|---|---|---|---|
| V1 | Extension loads; commands registered | RPC `get_commands` with `-e` (T1) | ✅ 4 commands registered, stderr empty |
| V2 | Worker RPC layer | `scripts/smoke-worker.ts` (T2) | ✅ 2 turns, 1 bash call, result `pong`, $0.025, 2.7 s, exit code 0 |
| V3 | Thinking capture | smoke test with `thinking: xhigh` (T3) | ✅ Thinking streamed into the transcript and `┊` log lines. A trivial `low` prompt had no thinking; this is expected, because the provider uses adaptive thinking |
| V4 | Parallel workers + `worker_wait` | `pi -p` manager (T4) | ✅ Both results correct, 11.4 s total |
| V5 | Auto-notify | manager driven over RPC; `worker_spawn` without wait | ✅ Spawn returned in 0.6 s; result delivered at 14.4 s; the manager replied `sleeper said: done-sleeping` on its own |
| V6 | Plain-text widget (RPC host) | same run | ✅ 10 widget updates with status, tool activity and result |
| V7 | TUI widget | interactive pi in tmux (T6) | ✅ Live 💭 thinking tail, tool activity, counters, elapsed time |
| V8 | `/workers` viewer | tmux (T6) | ✅ Task, thinking, tool calls and results; `Home`, `→`; `m` → new task → `ack` |
| V9 | Abort mid-tool, then reuse | `Worker` driven directly | ✅ Abort returned in 3 ms; status `aborted`; the next task succeeded |
| V10 | Crash detection | `kill -9` on a busy worker | ✅ Status `crashed` with the reason, `settled` emitted, later prompts rejected |
| V11 | Shutdown cleanup | every run above | ✅ All workers exited with code 0 when their manager ended; 0 orphan processes |
| V12 | Event log compaction | before/after the fix | ✅ ~40 KB for a 2-turn task before; ~14 KB for 3 tasks after |
| V13 | Doc recipes | every `jq` command in docs/observability.md, run against real logs | ✅ All work |

## Not yet verified

- Dialog forwarding (`select`/`confirm`/`input`/`editor`) from extensions running inside workers.
- `worker_send` with `steer` / `followUp` while a worker is busy (RPC `steer` / `follow_up`).
- `worker_stop` called by the manager LLM; `/worker-send`, `/worker-stop`, `/workers-clear`; viewer keys `a` and `k`.
- `worker_wait` timeout and `Esc`-cancel paths.
- `PI_MULTI_AGENT_MAX_WORKERS`, `PI_MULTI_AGENT_DIR`, `PI_MULTI_AGENT_WORKER_ARGS`.
- Retry and compaction events inside long-running workers.
- A manager hosted by pi-web; Linux; Windows.
- Two managers running at once (they share the `latest` symlink).
- A worker dialog that arrives while the `/workers` viewer is open.

## Known issues & limitations

1. **No reattach.** Workers end with the manager session (quit, `/new`, `/resume`, `/fork`, `/reload`).
2. **No file locking** between workers. Parallel edits to the same file can conflict.
3. **Thinking visibility depends on the provider.** Adaptive or summarized thinking may be absent on easy tasks.
4. **Child usage is not in the manager's footer totals.** It is shown per worker instead.
5. **`PI_MULTI_AGENT_WORKER_ARGS` is split on whitespace.** Arguments that contain spaces cannot be passed.
6. **`scripts/watch.sh`** expands its glob once, so workers spawned later need a re-run.
7. **Possible duplicate result.** If the manager explicitly names an already auto-notified worker in `worker_wait`, the
   same result is returned again. (The default `worker_wait` target list excludes reported workers.)
8. **Session list clutter.** Worker sessions (`worker:<name>`) are saved by default.
9. **The `latest` symlink** is shared by all managers. The newest run wins.
10. **Viewer height** is derived from `process.stdout.rows`, so very small terminals may clip.
11. **Viewer history is capped** at 400 entries and 20,000 chars per entry. The `.log` file has everything.
12. **`role` is append-only.** There is no full system prompt replacement and no reusable agent definitions yet.
13. **The tools allowlist is not a sandbox.** Workers have your OS permissions.
14. **Development artifacts** on this machine: 9 worker sessions and 3 run directories from testing. Clean them up
    with the [Runbook maintenance](RUNBOOK.md#maintenance) commands.

## Roadmap

**P1: harden**
- Automated tests with a fake RPC worker (a scripted JSONL process), so the `Worker` state machine, auto-notify and
  wait logic can be tested without model calls. Add a CI workflow.
- Type checking: a `tsconfig.json` with pi's type packages and `npm run check`.
- Verify the items under [Not yet verified](#not-yet-verified).

**P2: features**
- Reusable agent definitions (`~/.pi/agent/agents/*.md`, compatible with pi's subagent example):
  `worker_spawn { agent: "reviewer", task }`.
- Per-worker budgets (max cost, turns or wall time) with automatic abort.
- Optional git worktree isolation per worker for safe parallel edits.
- A queue instead of a hard limit when `PI_MULTI_AGENT_MAX_WORKERS` is reached.
- Full system prompt replacement, and per-worker extra CLI args.

**P3: nice to have**
- Reattach to workers after `/reload` (detached workers with a socket).
- A split-view dashboard of all workers; overlay mode for the viewer.
- HTML export of worker transcripts (RPC `export_html`) linked from results.
- Report worker usage to the manager's totals (tool-result `usage`).

## Progress log

### 2026-11-24

- Researched pi 1.6.0's multi-agent options: extensions, RPC and JSON event docs, the SDK, the TUI, and the bundled
  `subagent` example. Chose long-lived RPC workers over one-shot JSON subagents, for steering, follow-ups,
  persistent context and live thinking.
- Implemented v0.1.0: `worker.ts` (own JSONL RPC client), `index.ts` (5 tools, 4 commands, auto-notify,
  lifecycle), `ui.ts` (widget, viewer), `format.ts`, and `scripts/watch.sh` / `scripts/smoke-worker.ts`.
- Verified V1–V11 (worker layer, thinking, parallel wait, auto-notify, TUI and RPC widgets, viewer, abort,
  crash, shutdown).
- Fix: compacted `<name>.events.jsonl` (V12).
- Initialized the git repo; baseline commit on `main`.
- Docs: README rewrite, STATUS (this file), RUNBOOK, and `docs/` (user guide, observability, architecture,
  reference). Verified the doc recipes (V13). Merged branch `docs/readme-status-runbook` into `main`.
