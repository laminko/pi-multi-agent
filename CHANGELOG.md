# Changelog

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
