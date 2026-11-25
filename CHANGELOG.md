# Changelog

## 0.9.0 — 2026-11-25

Idle cleanup. Finished workers that nobody reuses no longer keep a pi process for the rest of the session.

### Added

- A worker that finished and was not reused for `PI_MULTI_AGENT_IDLE_MINUTES` (default 10; `0` or `off` = never)
  has its process stopped. Never while it is busy, starting, has queued messages or an open dialog, or is waited on.
- It stays listed as `○ stopped` with `stopped while idle · worker_send revives it with its context`; its result,
  log and session stay. Info toast for you; no message to the manager LLM.
- `worker_send`, `/worker-send` and the viewer's `m` key revive it on its own session file (same model, thinking,
  tools, role, cwd), so it keeps its context. Counters and viewer history carry over. Killed workers are not revived.
- `worker_status` shows the idle setting. `idle.ts`; `scripts/test-idle.ts` (Runbook T15, 21 checks, no model calls);
  `scripts/test-idle-live.ts` (T16, real model).
- Tool result `details.workers[]` include the worker's `pid`.

## 0.8.0 — 2026-11-25

Health checks. The manager notices stuck workers and follows up on them by itself.

### Added

- While at least one worker runs, the manager checks every busy worker every 10 s. Set the interval with
  `PI_MULTI_AGENT_HEALTH_INTERVAL` (seconds; `0` or `off` turns checks off). A check costs no model tokens: one
  `get_state` heartbeat to the worker process plus a look at its last event and its recent tool calls.
- Verdicts: **quiet** (no event for `PI_MULTI_AGENT_STALL_SECONDS`, default 180), **not answering** (3 heartbeats
  in a row without a reply), **loop** (5 identical tool calls in a row). A worker that waits for your answer to a
  dialog is never flagged.
- On a problem: a warning toast; `⚠ quiet 3m05s` / `⚠ not answering` / `⚠ loop ×5` before the activity in the
  widget, the status table and the viewer, plus `N may be stuck` in the widget summary; and an alert message to the
  manager LLM (`multi-agent-health`, follow-up that starts a turn) with what to do for that verdict. Shown in the TUI
  as `⚠ worker <name> may be stuck (…)`. The alert repeats while the problem lasts, each time it has lasted about
  twice as long (3, 6, 12 … min). A toast tells you when the worker moves again.
- `worker_wait` (and `wait: true`) ends early with outcome `stalled` when a waited-for worker gets an alert, instead of
  blocking until the timeout.
- `worker_status` shows the health settings; `worker_status <name>` a `health:` line. A prompt guideline tells the
  manager to follow up on alerts and tell the user.
- `health.ts`; `scripts/test-health.ts` (Runbook T13, 33 checks, no model calls: the script also plays a fake RPC
  worker that goes quiet, freezes or loops); `scripts/test-health-live.ts` (T14).

### Changed

- Heartbeat replies are not written to `<name>.events.jsonl`.
- `scripts/lib/pi-packages.ts` also resolves `typebox`, so tests can import `index.ts`.

### Tested

- T13: 33 of 33 PASS. T1, T10, T11, T12 still pass.
- T14 with `claude-code/claude-haiku-5-5`: the alert came 15 s after the worker went silent; the manager called
  `worker_status` on its own, judged the `sleep 120` legitimate, left it running and told the user. No orphans.
- Interactive TUI (tmux, fullscreen): the `⚠` warning and `1 may be stuck` in the widget, the rendered alert
  message, a repeat alert, and the warning clearing when the worker finished.

## 0.7.0 — 2026-11-24

Resume after pi quits. Worker processes still stop with the manager, but their work can be continued.

### Added

- The manager records each worker's state in its own session (custom entries, not sent to the model).
- Reopening the manager session (`pi -c`, `pi -r`, `/resume`, or `/reload`) restores workers that were busy as
  `↯ interrupted`, with a toast and a widget hint.
- `/workers-resume [name ...]` and the `worker_resume` tool continue interrupted workers in their **own sessions**, with
  their context, and tell them to check what is already done. Without a session file the task restarts instead.
- Session repair: if pi quit while the model was making a tool call, the worker session is fixed (an error result per
  unanswered call) before resuming. Without it the provider rejects the session with a 400.
- New status `interrupted` (`↯`), in the widget, the status table, the legend and the viewer.
- `PI_MULTI_AGENT_WORKER_SESSION_DIR`; `scripts/test-resume.ts` (Runbook T12, 10 checks, no model calls).
- Runbook: "Recovering after pi quits".

### Changed

- New workers store their sessions in `~/.pi/agent/multi-agent/sessions/` (`--session-dir`), so `pi -c` in a project
  opens the manager. Before, the worker session was usually the newest and `pi -c` opened it. A session flag in
  `PI_MULTI_AGENT_WORKER_ARGS` still wins.
- `/workers-clear` and `/worker-stop <name> kill` dismiss interrupted workers for good; `worker_send` to an
  interrupted worker points to `worker_resume`.

### Fixed

- `worker_wait` called in the same message as `worker_spawn` or `worker_resume` (pi runs them in parallel) could see
  the new worker still `starting` and return at once. A starting or resuming worker now counts as working, and the
  wait follows a worker that was replaced by a resume.
- (During development) a note about interrupted workers, queued when the session opened, reached the model after the
  user had already resumed them. The note is now built when the next run starts, only if still relevant.

### Tested

- T12: 10 of 10 PASS. T1, T10, T11 still pass.
- Against the real provider: an unrepaired session ending in an aborted tool call fails with 400; after repair the
  worker continues (`repaired-ok`).
- Live in tmux (haiku): quit mid `sleep 25`, `pi -c` opened the manager, `/workers-resume` continued the worker in the
  same session file; it checked the files, redid only the interrupted step, and reported `finished-all-steps`.
  Asking the manager in plain words led to `worker_resume` and one `worker_wait`. Dismissing with `/workers-clear`
  held across a reopen. No orphan processes.

## 0.6.0 — 2026-11-24

Worker results are rendered in the TUI instead of shown as raw text.

### Changed

- The `⚑ worker … done` message and the worker tool rows (`worker_wait`, `worker_status`, …) no longer show the
  `<worker …>` / `<result>` tags and the markdown table source. The status table is drawn as a table, the result is
  rendered as Markdown (collapsed: first 6 lines, `ctrl+o` expands), errors are red, and the log path is shown as
  `log: ~/…`. Text outside worker blocks, such as the legend, keeps its line breaks and alignment.
- The text the manager LLM gets is unchanged.

### Added

- `extensions/multi-agent/report.ts`: the result-block producer (moved from `index.ts`), a parser, and the renderer.
- `scripts/test-render-report.ts` (Runbook T11): 24 parse and render checks, no model calls.
- `scripts/lib/pi-packages.ts`: shared resolve hook so the test scripts can import pi's packages under plain Node.

### Fixed (during development)

- A result containing a `</result>` line followed by `</worker>` would have ended the block early. The end marker
  now requires the log note that every block has.

### Tested

- T11: 24 of 24 PASS. T10 and T1 still pass.
- Live in tmux (haiku): the auto-report of a worker's Markdown report showed a drawn table, the rendered heading and
  bold text, the collapsed hint and `log: ~/…`; `ctrl+o` expanded it, and the worker's own table was drawn too. The
  `worker_status` row showed a drawn table and the aligned legend.

## 0.5.0 — 2026-11-24

Many workers: nothing important is hidden. There is still no scrollbar.

### Changed

- Widget rows are sorted: running workers first (in spawn order), then error/crashed, then done/aborted, then
  stopped; the last three newest first. Before, rows were in spawn order, so past 8 workers the newest, running ones
  were hidden.
- The `… N more` line now says what is hidden, e.g. `… 4 more (3 done, 1 stopped)  ·  /workers to see all`.
- Viewer tab bar: when the tabs do not fit, it shows a window that always contains the current worker, with `‹ N` /
  `N ›` counting the hidden tabs on each side. The window moves only when needed, and the `worker i/N` counter is
  never cut off. Before, the bar was cut at the terminal width and could hide the current tab.

### Added

- `PI_MULTI_AGENT_WIDGET_ROWS` (default 8): maximum worker rows in the widget.
- Mouse: a click on the `… N more` line opens the viewer on the first hidden worker; a click on a `‹ N` / `N ›` marker
  switches to the nearest hidden worker on that side.
- `scripts/test-ui-overflow.ts` (Runbook T10): 18 rendering and click checks with fake workers, no model calls.

### Tested

- T10: 18 of 18 PASS.
- Live in tmux (150×45, haiku, 10 workers, `PI_MULTI_AGENT_MAX_WORKERS=12`): 8 rows and `… 2 more (2 running)`; a click
  on that line opened `lesson-worker-9` with `‹ 4 … 1 ›`; `←` reached `worker 1/10` and wrapped to `worker 10/10` with
  the tab visible. No orphan processes.

## 0.4.0 — 2026-11-24

Mouse support in pi's fullscreen mode. Every mouse action also has a key.

### Added

- Widget: a left click on a worker row opens `/workers` on that worker. A click on the summary or the header opens
  it on the first worker.
- Viewer: the first line is now a tab bar with one tab per worker. Click a tab to switch.
- Viewer: the wheel scrolls the transcript.
- Viewer: the actions on the help line can be clicked: `End follow`, `m message`, `a abort`, `k kill`, `esc close`.

### Tested

- Unit checks with fake mouse events: 7 of 7 PASS. They cover the widget row, the summary, a right click
  (ignored), a tab click, the wheel, `End follow` and `m message`.
- Live in tmux, fullscreen, with SGR mouse sequences: 3 of 3. A row click opened `worker-2`, a tab click switched to
  `worker-1`, and a click on `esc close` closed the viewer.

### Not changed

- Regular mode (`tuiMode: "regular"`): pi does not send mouse events, so the keys stay the only way.
- RPC hosts (pi-web): the widget is plain text, so it has no clicks.

## 0.3.0 — 2026-11-24

Status table with a legend is the default status format.

### Changed

- `worker_status` (no name), the `worker_wait` progress, and `/workers` without a TUI now print an aligned table.
  The table is valid markdown, and the legend follows it. Columns: St, Worker, Turns, Tools, Ctx, ↑In, ↓Out, Cost,
  Time, Now.
- Result blocks (`<worker …>`) and the `worker_status <name>` report use the same table. Result blocks omit the
  legend, to save tokens.
- The TUI widget uses the same column names with a header row. Its `Now` column is the live preview.
- The `worker_status` description tells the manager to show the table and the legend as they are.

### Added

- `/workers-legend`: shows the table and the meaning of each column.
- `format.ts`: `statusTable`, `statusCells`, `STATUS_LEGEND`.

### Removed

- `statusLine` (the old one-line format). `statsText` stays for the `/workers` viewer header.

### Not changed

- Counters still add up over the whole life of the worker. Only Time is per task. The legend says this.
- Worker names are still chosen by the manager. There is no automatic `worker-N` naming.

## 0.2.1 — 2026-11-24

### Fixed

- The toast for a finished worker showed as `Warning:`. The code compared the status to `"done"`, but that word is
  only the label. The settled-OK status is `"idle"`. The toast is now `info` for done, and `warning` for the other
  statuses.
- In 1 of 2 T8 runs, the manager blocked with `wait: true` on `worker_spawn`, instead of with `worker_wait`. The
  guideline, the `wait` parameter text and the spawn result now all say: wait only when the user asks.

### Tested

- Follow-up (`Alt+Enter`) interrupt: `TEST_MODE=follow_up` for T7. Result: 3 of 3 `interrupted`, 210 ms each.
- Interactive TUI in tmux (RUNBOOK T9). Enter interrupt: 463 ms. Alt+Enter interrupt: 490 ms. The toast showed at
  info level, and the auto-report arrived.
- Regression: T7 × 3, T7 follow-up × 3, T8 × 3, for a total of 9 of 9 PASS.
- T8 now counts `wait: true` as a blocking wait.

## 0.2.0 — 2026-11-24

Non-blocking manager. You can talk to the manager while workers run.

### Problem

The manager called `worker_wait` after each spawn. That call blocked its turn for up to 1800 s.
Pi delivers a message that you type only after the current tool call ends.
So you could not reach the manager, and you could not steer workers through it.

### Changed

- `worker_wait`, and `worker_spawn` / `worker_send` with `wait: true`, now end early when you type a message.
  The new outcome is `interrupted`. The workers keep running, and they auto-notify later.
  The check is `ctx.hasPendingMessages()`, one time in each 400 ms poll.
- Tool prompts: after a spawn, the manager ends its turn. It calls `worker_wait` only when you ask it to wait.
  When a result message arrives, it reports the result to you.
- A toast, `Worker <name> <status>`, shows for each finished worker. It shows at once, even while the manager is busy.

### Added

- `scripts/test-wait-interrupt.ts` (RUNBOOK T7). Result: `interrupted` in 211 ms, with 1 of 1 worker still running.
- `scripts/test-auto-report.ts` (RUNBOOK T8). Result: 0 `worker_wait` calls, 1 toast, 2 manager turns.
- `INDEX.md`, made by `make_index.sh`.

### Not changed

- No new tool parameters. `notify: false` still means "collect with `worker_wait` or `worker_status`".
- No change to `worker.ts`, `ui.ts` or `format.ts`.
- Not tested in 0.2.0: a `followUp` message (`Alt+Enter`), and the interactive TUI. Both were tested in 0.2.1.

## 0.1.0 — 2026-11-24

First version: a manager pi with worker pis over RPC, 5 tools, 4 commands, a widget, the `/workers` viewer and logs.
