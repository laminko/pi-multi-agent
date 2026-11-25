# Status & Progress

| | |
|---|---|
| **Version** | 0.9.0 |
| **State** | 🟢 Working prototype. The core flows are verified end-to-end by hand. There is no automated test suite yet |
| **Last updated** | 2026-11-25 |
| **Tested on** | macOS (Darwin 27.2), pi 1.6.0, Node v26.2.0, tmux 3.8; models `claude-code/default`, `claude-code/claude-haiku-5-5`; real-project test: Python 3.15, SQLite 3.54 |

## Component status

| Area | Status | Notes |
|---|---|---|
| Worker RPC layer (`worker.ts`) | ✅ Done · verified | Spawn, handshake, tasks, events → state, logs, abort, crash detection, shutdown |
| Manager tools | ✅ Done · mostly verified | `worker_spawn`, `worker_wait`, `worker_status` used by a real manager LLM. `worker_send` was verified for idle workers only. `worker_stop` was not driven by an LLM yet (its underlying abort/stop is verified) |
| Auto-notify | ✅ Done · verified | The result is delivered and the manager reacts on its own. A user toast shows for each finished worker (V15) |
| Non-blocking manager | ✅ Done · verified | The manager does not wait after a spawn (V15). Typing ends a `worker_wait` in < 1 s (V14) |
| Widget | ✅ Done · verified | TUI component and plain-text lines for RPC hosts. Status-table columns with a header row (V20). Running workers first; `… N more (…)` past 8 rows (V24, V25) |
| Mouse (fullscreen) | ✅ Done · verified | Widget row click, viewer tab click, wheel, help-line actions (V22, V23) |
| Resume after quit | ✅ Done · verified | Records, `↯ interrupted` restore, `/workers-resume`, `worker_resume`, session repair, worker sessions in their own dir (V28–V34) |
| Health checks (stuck workers) | ✅ Done · verified | Every 10 s while workers run: heartbeat + quiet / not answering / loop verdicts, toast, `⚠` warning, alert to the manager LLM, `worker_wait` ends `stalled` (V36–V39) |
| Idle cleanup | ✅ Done · tested without a model | Idle worker processes stop after `PI_MULTI_AGENT_IDLE_MINUTES` (10); `worker_send` revives them on their session (V40). Live with a real model: V41. Not yet seen in the TUI |
| Result rendering (TUI) | ✅ Done · verified | Worker blocks in tool rows and `⚑` messages: drawn table, Markdown result, no tags (V26, V27) |
| Status table + legend | ✅ Done · verified | Default format for `worker_status`, wait progress, result blocks, `/workers-legend` (V19, V20) |
| `/workers` viewer | ✅ Done · verified | Rendering, scrolling, switching, `m` message, tab window for many workers (V24, V25). The `a`/`k` keys were not exercised |
| Slash commands | ⚠️ Partly verified | `/workers` verified; `/worker-send`, `/worker-stop` and `/workers-clear` not exercised |
| Logs, result files, event log | ✅ Done · verified | Event log compaction verified (40 KB → 14 KB) |
| Dialog forwarding from workers | ⚠️ Implemented, untested | No extension raised a dialog during testing |
| Documentation | ✅ Done | README, RUNBOOK, STATUS, docs/ |
| Automated tests | ⚠️ Partly | No-model scripts T10–T13; T13 runs the extension with a fake RPC worker process. No CI yet |
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
| V14 | Typing interrupts `worker_wait` | `scripts/test-wait-interrupt.ts` (T7), `claude-code/claude-haiku-5-5` | ✅ `outcome=interrupted`, 211 ms after the steer; 1 of 1 worker still running |
| V15 | No wait after spawn; toast; auto-report | `scripts/test-auto-report.ts` (T8) | ✅ 0 `worker_wait` calls; 1 toast `Worker sleeper done`; 2 `agent_end`; the manager reported the result |
| V16 | Interrupt with a follow-up message | `TEST_MODE=follow_up` T7, 3 runs | ✅ 3 of 3 `interrupted`, 210 ms each |
| V17 | Interactive TUI: steer and Alt+Enter interrupt, toast, auto-report | tmux, haiku (T9) | ✅ Enter: wait text shown 463 ms after the keypress; Alt+Enter: 490 ms; the manager answered both; toast `Worker s3 done` at info level; `⚑ worker s3 done` reported |
| V18 | Regression after 0.2.1 prompt fix | T7 × 3, T7 follow-up × 3, T8 × 3 | ✅ 9 of 9 PASS (T8 now also counts `wait: true`) |
| V19 | Status table rendering | `statusTable` with fake workers: running with 2 failed tools and 1 queued; crashed | ✅ Columns align; `37 (2✗)`, `(+1 queued)`, the error text in Now; the legend follows |
| V20 | Table in the TUI | tmux, 2 workers, `worker_status` and `/workers-legend` | ✅ Widget header and rows align; `/workers-legend` shows the table and 11 legend lines |
| V22 | Mouse logic | fake events into `createWidgetComponent` / `createViewer` | ✅ 7 of 7 |
| V23 | Mouse in fullscreen TUI | tmux 150×45, SGR press/release sequences | ✅ 3 of 3: row → viewer on `worker-2`; tab → `worker-1`; `esc close` → closed |
| V21 | Regression after 0.3.0 | T1, T7, T7 follow-up, T8 | ✅ T1 5 commands incl. `workers-legend`; T7 210 ms; follow-up 213 ms; T8 0 waits, 1 toast |
| V24 | Many workers, rendering logic | `scripts/test-ui-overflow.ts` (T10): fake workers, pi-tui width functions | ✅ 18 of 18: row order, `… 4 more (3 done, 1 stopped)`, `PI_MULTI_AGENT_WIDGET_ROWS=3`, 4 widget clicks, tab window at widths 120/80/60 and long names, 2 marker clicks |
| V26 | Result rendering, logic | `scripts/test-render-report.ts` (T11): real producer → parser → renderer | ✅ 24 of 24. First run found a parser bug: a result containing `</result>` then `</worker>` ended early. Fixed by requiring the log note in the end marker |
| V27 | Result rendering, live TUI | tmux 150×60, haiku, 1 worker with a Markdown report, auto-report; then `worker_status` | ✅ `⚑` message: drawn table, heading and bold rendered, `… 7 more lines (ctrl+o to expand)`, `log: ~/…`; `ctrl+o` showed the worker's own table drawn; `worker_status` row: drawn table + aligned legend; T1, T10 pass; 0 orphans |
| V28 | Resume logic | `scripts/test-resume.ts` (T12): records, real session files | ✅ 10 of 10 |
| V29 | Repair against the real provider | session ending in an aborted tool call, `pi --session … -p continue`, haiku | ✅ Without repair: the provider's 400 `tool_use ids were found without tool_result blocks`; after `repairSession` (1 result added): `repaired-ok` |
| V30 | Quit and resume, live | tmux, haiku; worker writes step1, `sleep 25`, step3; SIGHUP mid-sleep; `pi -c`; `/workers-resume` | ✅ Last record `busy: true`; `pi -c` opened the manager; widget `↯ 1 interrupted`; worker resumed **in the same session file**, checked the files, re-ran only the sleep and step 3; `finished-all-steps`; 0 orphans |
| V31 | Stale note (bug found in V30) | same, after the fix | ✅ Before: the note queued at startup arrived after `/workers-resume` and the manager said the worker was "not running". After (note built in `before_agent_start`): no stale claim |
| V32 | Resume by asking the manager | `pi -p -c "My workers got interrupted. Please continue them…"` | ✅ `worker_resume` (not `worker_spawn`), then the result. First run exposed a race: `worker_resume` + `worker_wait` in one message, the wait saw the new worker `starting` and returned at once. After the fix: one wait, `status="done"` |
| V33 | Dismiss | RPC: session with a busy record, `/workers-clear`, reopen | ✅ Toast on open; `stopped` record appended; no interrupted worker on reopen |
| V34 | Regression | T1, T10, T11 | ✅ 6 commands incl. `workers-resume`; 18/18; 24/24 |
| V35 | Real project with a quit in the middle | a scratch project (`todo-sqlite`): interactive manager in tmux, `claude-code/default`, thinking medium. Prompt: Python + SQLite todo app built by parallel workers (db layer, CLI, tests), then run tests, fix, read-only review. Terminal killed while `tests` was mid tool call; `pi -c`; `/workers-resume` | ✅ Manager wrote the contract (`API.md`) and spawned 3 workers. `db-layer` and `cli` finished and reported before the quit; `tests` was restored as interrupted, its session repaired (1 tool call), resumed in the same file. Manager then ran 39 tests (all pass), spawned a reviewer (no high-severity bugs, 4 medium), and asked about fixes. Live 💭 thinking in the widget throughout. Checked by hand: 39/39 tests, CLI add/done/delete/list/`--open`/error exit 1, `sqlite3` rows and schema, reviewer finding "huge id → OverflowError" confirmed. Total $0.83; 0 orphans |
| V36 | Health check logic and extension loop | `scripts/test-health.ts` (T13): pure verdicts and timing; the extension with a mocked pi API and fake worker processes (quiet, frozen, looping) | ✅ 33 of 33. Alerts: quiet 1×, unresponsive, looping; `stalled` wait in ~3 s; heartbeat replies kept out of the events log; 0 orphans |
| V37 | The manager follows up by itself | `scripts/test-health-live.ts` (T14), `claude-code/claude-haiku-5-5`, interval 2 s, stall 15 s, worker in `sleep 120` | ✅ Toast and alert 15 s after the worker went silent; the manager started a turn on its own, called `worker_status sleeper`, judged the sleep legitimate, left it running and told the user. 0 orphans. With `claude-local/claude-haiku-4-5` the test cannot run: that model wrote its tool call as text, so the worker never slept |
| V38 | Regression | T1 (`--no-extensions -e`), T10, T11, T12 | ✅ 6 commands; 21/21; 24/24; 10/10 |
| V39 | Health checks in the interactive TUI | tmux 160×50, fullscreen, haiku, interval 2 s, stall 15 s, worker in `sleep 120` | ✅ Widget: `1 may be stuck` and `⚠ quiet 21s ⟳ bash $ sleep 120`; alert message: `⚠ worker sleeper may be stuck (quiet)`, detail line, drawn table, settings, advice; the manager called `worker_status` and left it running. Repeat alert at ~78 s of quiet: the manager checked again and left it. Result at 2m03s; the `⚠` and the summary count cleared. 0 orphans. The repeat alert's `still stuck` header was not seen on screen (checked by T13) |
| V40 | Idle cleanup | `scripts/test-idle.ts` (T15), fake RPC workers, idle time 2 s; T1, T10–T13 re-run | ✅ 21 of 21: idle process stopped, reused one kept, listed with hint, toast, no manager message, revived on its session with counters, killed not revived, 0 orphans. T1 6 commands; T10–T13 all pass |
| V41 | Idle cleanup, live | `scripts/test-idle-live.ts` (T16) in `todo-sqlite`, `claude-code/claude-haiku-5-5`, idle 30 s | ✅ Worker done at 8 s, auto-reported; toast `stopped after 32s idle` at 39.7 s, pid gone; `worker_send` revived it (new pid, same session file per its log), answer had the random code word without reading files; 0 orphans. First run passed on behavior but its pid lookup was wrong; `details.workers[].pid` added for that. (Haiku's test count was off: 57 vs 51 real; not related) |
| V25 | Many workers, live TUI | tmux 150×45, haiku, `PI_MULTI_AGENT_MAX_WORKERS=12`, 10 workers running `sleep 90` | ✅ 8 rows + `… 2 more (2 running)`; click on that line → viewer on `lesson-worker-9` with `‹ 4 … 1 ›`; 8×`←` → `worker 1/10`; `←` wraps to `worker 10/10`, tab visible; T1 still passes; 0 orphans |

## Not yet verified

- Idle cleanup: the viewer `m` and `/worker-send` revive paths; seen in the TUI.
- Dialog forwarding (`select`/`confirm`/`input`/`editor`) from extensions running inside workers.
- `worker_send` with `steer` / `followUp` while a worker is busy (RPC `steer` / `follow_up`).
- `worker_stop` called by the manager LLM; `/worker-send`, `/worker-stop`, `/workers-clear`; viewer keys `a` and `k`.
- `worker_wait` timeout and `Esc`-cancel paths. (The user-message interrupt path is verified: V14, V16, V17.)
- `PI_MULTI_AGENT_DIR`, `PI_MULTI_AGENT_WORKER_ARGS`. (`PI_MULTI_AGENT_MAX_WORKERS` raised to 12: verified in V25.)
- The widget reordering while workers finish, seen live (V24 checks the order logic only).
- Resume after a hard kill of the manager (SIGKILL), where workers may still be finishing (the old-process check is
  unit-tested only), and a resume of more than one worker at once.
- Resume after `/reload` and `/resume` inside a running pi (same code path as startup, not run live).
- A rendered `worker_wait` tool row seen live (same renderer as the verified `worker_status` row and `⚑` message;
  its parse/render is covered by V26).
- Retry and compaction events inside long-running workers.
- A manager hosted by pi-web; Linux; Windows.
- Two managers running at once (they share the `latest` symlink).
- A worker dialog that arrives while the `/workers` viewer is open.

## Known issues & limitations

1. **No live reattach.** Worker processes end with the manager session (quit, `/new`, `/resume`, `/fork`,
   `/reload`). Since v0.7.0, workers that were busy can be resumed in their own sessions; a resumed worker redoes
   the step it was in.
2. **No file locking** between workers. Parallel edits to the same file can conflict.
3. **Thinking visibility depends on the provider.** Adaptive or summarized thinking may be absent on easy tasks.
4. **Child usage is not in the manager's footer totals.** It is shown per worker instead.
5. **`PI_MULTI_AGENT_WORKER_ARGS` is split on whitespace.** Arguments that contain spaces cannot be passed.
6. **`scripts/watch.sh`** expands its glob once, so workers spawned later need a re-run.
7. **Possible duplicate result.** If the manager explicitly names an already auto-notified worker in `worker_wait`, the
   same result is returned again. (The default `worker_wait` target list excludes reported workers.)
8. **Old worker sessions in project lists.** Workers from before v0.7.0 saved their sessions in the project's list
   (where `pi -c` could pick them). New ones use `~/.pi/agent/multi-agent/sessions/`, which pi-web does not list.
9. **The `latest` symlink** is shared by all managers. The newest run wins.
10. **Viewer height** is derived from `process.stdout.rows`, so very small terminals may clip.
11. **Viewer history is capped** at 400 entries and 20,000 chars per entry. The `.log` file has everything.
12. **`role` is append-only.** There is no full system prompt replacement and no reusable agent definitions yet.
13. **The tools allowlist is not a sandbox.** Workers have your OS permissions.
14. **Development artifacts** on this machine: 9 worker sessions and 3 run directories from testing. Clean them up
    with the [Runbook maintenance](RUNBOOK.md#maintenance) commands.
15. **`/fork` copies worker records.** A forked manager session can offer the same interrupted worker as the
    original; resume it from one of them only.
16. **Log of a worker cut off mid tool call may lack its last lines.** When the terminal closes, the manager can
    be gone before that worker exits, so its `.log` has no `ABORTED` / `stopped` lines. The worker still exits
    (no orphans), and its record and session are correct (seen in V30's first run and in V35).
17. **Health checks cannot tell a silent step from a hang.** A long tool call without output or a model that
    thinks without streaming is flagged `quiet` after 3 minutes. The manager is told so and usually leaves the worker
    running, but each alert costs a manager turn. Raise `PI_MULTI_AGENT_STALL_SECONDS` for such work. A loop is only
    detected when the calls are identical and consecutive.

## Roadmap

**P1: harden**
- Automated tests with a fake RPC worker (a scripted JSONL process), so the `Worker` state machine, auto-notify and
  wait logic can be tested without model calls. Started in v0.8.0 (`scripts/test-health.ts` has one); extend it
  to auto-notify and resume, and add a CI workflow.
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
- Live reattach: detached workers behind a socket that survive the manager (v0.7.0 resumes the work instead).
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
- v0.2.0, non-blocking manager. Issue: a user message typed during `worker_wait` waited up to 1800 s, so the user
  could not steer workers through the manager. Fix: the wait returns `interrupted` on a pending user message; the
  manager is told not to wait after a spawn; each finished worker shows a toast. Verified V14 and V15.
  Added `INDEX.md` and `CHANGELOG.md`.
- v0.4.0. Mouse support in fullscreen mode: widget rows, viewer tabs, wheel, help-line actions. Verified V22, V23.
- v0.3.0. The status table with a legend is the default status format, and there is a new `/workers-legend`
  command. Verified V19–V21.
- v0.2.1. Verified the follow-up path (V16) and the interactive TUI (V17). Found and fixed 2 defects: the done
  toast showed as a warning, and in 1 of 2 T8 runs the manager used `wait: true` on `worker_spawn`. Verified V18.
- v0.5.0. Many workers. Issue: past 8 workers the widget showed the 8 oldest (in spawn order) and `… N more`, so
  newly spawned, running workers were the hidden ones; the viewer tab bar was cut off at the terminal width, which
  could hide the current tab and the `worker i/N` counter. Fix: running workers sort first, the more-line names the
  hidden statuses and is clickable, `PI_MULTI_AGENT_WIDGET_ROWS`; the tab bar shows a window with `‹ N` / `N ›`
  markers. Added `scripts/test-ui-overflow.ts` (T10). Verified V24, V25.
- v0.6.0. Result rendering. Issue: worker results showed as raw LLM text in the TUI (`<worker …>` and `<result>`
  tags, markdown table source, unrendered Markdown). Fix: new `report.ts` parses the unchanged LLM text and renders it
  (drawn tables, Markdown result, hidden tags, short log path). Added `scripts/test-render-report.ts` (T11) and
  `scripts/lib/pi-packages.ts`. Verified V26, V27.
- v0.7.0. Resume after quit. Issue: quitting pi stopped all workers with no way back; `pi -c` reopened a worker's
  session instead of the manager; resuming a worker's session by hand failed with a provider 400 when pi had quit
  mid tool call. Fix: the manager records worker state in its session, restores busy workers as `↯ interrupted`, and
  `/workers-resume` / `worker_resume` continue them in their own sessions after repairing unanswered tool calls; new
  worker sessions go to `~/.pi/agent/multi-agent/sessions/`. Found and fixed during testing: a stale note to the
  model (V31) and a wait race with parallel tool calls (V32), which also affected `worker_spawn` + `worker_wait`.
  Added `scripts/test-resume.ts` (T12). Verified V28–V34.
- Real-project test (V35): a Python + SQLite todo app built by 3 parallel workers plus a reviewer, with a terminal
  kill in the middle and `/workers-resume`. Everything worked; the app was checked by hand. One cosmetic finding:
  known issue 16. The project was a scratch directory, not part of this repo.

### 2026-11-25

- v0.8.0. Health checks. Issue: nobody noticed a stuck worker; the manager only heard from a worker when it
  finished, and a `worker_wait` on a hung worker blocked until its 30-minute timeout. Fix: while workers run, the
  manager checks each busy worker every 10 s (`PI_MULTI_AGENT_HEALTH_INTERVAL`): a `get_state` heartbeat plus the
  time of its last event and repeated tool calls. A quiet (180 s, `PI_MULTI_AGENT_STALL_SECONDS`), unresponsive or
  looping worker gets a `⚠` warning, a toast, and an alert to the manager LLM, which follows up on its own; a wait
  on it ends `stalled`. Added `health.ts`, `scripts/test-health.ts` (T13, with a fake RPC worker) and
  `scripts/test-health-live.ts` (T14). Verified V36–V39.
