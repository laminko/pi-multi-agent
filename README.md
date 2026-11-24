# pi-multi-agent

A **manager pi** that runs **worker pis**, so one pi session can delegate work to several others in parallel
and still show you what each one is doing: its thinking, progress, status and result.

Each worker is a long-lived `pi --mode rpc` process with its own context window, model, thinking level, tool
allowlist and role prompt. The manager's LLM gets `worker_*` tools to spawn, message, wait for, inspect and stop
workers. You get a live widget, a full-screen viewer, log files and the workers' own pi sessions.

```
you ──► manager pi (+ this extension)
          ├─ tools: worker_spawn · worker_send · worker_wait · worker_status · worker_stop
          ├─ widget above the editor (status, latest thinking, cost)
          └─ /workers viewer (live thinking, output, tool calls)
                 │ JSONL over stdin/stdout (pi RPC mode)
     ┌───────────┼───────────┐
  worker pi   worker pi   worker pi      each with its own session file + live log
```

**Status:** v0.1.0, a working prototype whose core flows were verified end-to-end. See [STATUS.md](STATUS.md).

## Quick start

```bash
# try it for one session
pi -e /path/to/pi-multi-agent/extensions/multi-agent/index.ts

# or enable it everywhere (-l: only this project)
pi install /path/to/pi-multi-agent
```

Then ask the manager in plain language:

> Spawn three workers in parallel: one reviews `src/auth` for security issues (read-only), one writes tests for
> `src/api/users.ts`, one checks `docs/` for outdated examples. Wait for all of them and summarize.

While they run:

- the **widget** above the editor shows each worker's status, turns, tool calls, cost, elapsed time, and its latest
  thinking (💭) or current tool (⟳);
- **`/workers`** (or a click on a widget row) opens a live viewer with the full thinking, output and tool calls. A tab
  click or `←/→` switches worker, `m` messages
  it, `a` aborts, `k` kills;
- **`scripts/watch.sh`** follows the live logs from another terminal.

The manager does not block while workers run, so you can keep talking to it. When a worker finishes, you get a
toast, and the result is delivered to the manager automatically. The manager then reports it to you.

## Features

- Parallel workers with independent context, model, thinking level, tools (`read,grep,find,ls` = read-only) and role
- Long-lived workers: give follow-up work, steer mid-task, abort without killing
- Non-blocking manager: auto-notification of results and a toast per finished worker. `worker_wait` (live progress)
  only on request, and typing a message interrupts it
- Live visibility: widget, `/workers` viewer, streamed `.log` files, compact `.events.jsonl`, final `.result.md`,
  and a persisted pi session per worker (viewable in pi or pi-web)
- Worker dialogs (e.g. permission prompts from your extensions) are forwarded to you
- Clean lifecycle: workers stop with the manager session, with escalation from abort to signals. No orphans
- Resume after pi quits: reopen with `pi -c`, and `/workers-resume` continues interrupted workers in their own
  sessions, with their context
- Works in the interactive TUI and in RPC hosts such as pi-web (plain-text widget)

## Documentation

| Document | Read it for |
|---|---|
| [User Guide](docs/user-guide.md) | Mental model, prompting patterns, writing worker tasks, stepping in, cost, FAQ |
| [Observability](docs/observability.md) | Seeing thinking, progress, status and results: widget, viewer, logs, `jq` recipes, session files |
| [Reference](docs/reference.md) | Tool parameters and defaults, result format, commands, keys, statuses, files, env vars, limits |
| [Architecture](docs/architecture.md) | Internals: process model, RPC usage, state machine, notification, UI, design decisions |
| [Runbook](RUNBOOK.md) | Install, smoke tests, operating, troubleshooting, emergency stop, maintenance |
| [Status & Progress](STATUS.md) | What's done and verified, known issues, roadmap, progress log |

## Repository layout

```
extensions/multi-agent/
  index.ts       entry: tools, commands, widget, auto-notify, lifecycle
  worker.ts      one worker: spawns `pi --mode rpc`, JSONL client, state, logs, shutdown
  ui.ts          widget + /workers viewer
  format.ts      shared formatting
  report.ts      worker result blocks: LLM text, parser, TUI rendering
  resume.ts      resume after quit: worker records, session repair
scripts/
  watch.sh          tail worker logs from another terminal
  smoke-worker.ts   smoke test for the worker RPC layer (node scripts/smoke-worker.ts)
  test-wait-interrupt.ts  end-to-end: typing interrupts worker_wait (RUNBOOK T7)
  test-auto-report.ts     end-to-end: no wait after spawn, result auto-reported (RUNBOOK T8)
  test-ui-overflow.ts     widget and viewer with many workers, no model calls (RUNBOOK T10)
  test-render-report.ts   result blocks: parse and render, no model calls (RUNBOOK T11)
  test-resume.ts          resume records and session repair, no model calls (RUNBOOK T12)
  lib/pi-packages.ts      lets the test scripts import pi's packages under plain Node
docs/            user guide, observability, reference, architecture
RUNBOOK.md  STATUS.md  CHANGELOG.md  INDEX.md  package.json (pi package manifest)
```

## Requirements

pi 1.6.0 (tested), with a configured model. Node.js with TypeScript type stripping (≥ 22.18) is needed only for
`scripts/smoke-worker.ts`.
