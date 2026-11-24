# Changelog

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
