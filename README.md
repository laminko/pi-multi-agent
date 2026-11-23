# pi-multi-agent

A **manager pi** that runs **worker pis**. Each worker is a long-lived `pi --mode rpc` process with its own
context window, model, thinking level, tools and system-prompt role. The manager's LLM gets `worker_*` tools.
You get live visibility into every worker: thinking, output, tool calls, status, cost and results.

```
you ──► manager pi (this extension)
          ├── worker_spawn / worker_send / worker_wait / worker_status / worker_stop
          ├── widget above the editor (live status + latest thinking)
          └── /workers viewer (full live transcript per worker)
                │ JSONL over stdin/stdout (pi RPC mode)
     ┌──────────┼──────────┐
  worker pi  worker pi  worker pi      ← each a full pi with its own session file + log
```

## Install

Try it for one session:

```bash
pi -e /path/to/pi-multi-agent/extensions/multi-agent/index.ts
```

Or install it as a package (adds it to `~/.pi/agent/settings.json`, so every pi session gets the tools):

```bash
pi install /path/to/pi-multi-agent
```

Use `pi install -l …` instead to enable it only for the current project (`.pi/settings.json`).

## Use

Just ask the manager, e.g.:

> Spawn three workers in parallel: one reviews `src/auth` for security issues (read-only),
> one writes tests for `src/api/users.ts`, one checks the docs for outdated examples. Wait for all and summarize.

The manager writes a self-contained task for each worker (workers cannot see the manager's conversation),
starts them, and collects results with `worker_wait`. If it does not wait, each result is delivered to it
automatically when the worker finishes, and the manager wakes up to handle it.

### Tools (for the manager LLM)

| Tool | What it does |
|---|---|
| `worker_spawn` | Start a worker with `name`, `task`, optional `role` (appended system prompt), `model`, `thinking`, `tools` (allowlist, e.g. `read,grep,find,ls` for read-only), `cwd`, `wait`, `notify` |
| `worker_send` | Message a worker. Idle: starts a new task (it keeps its context). Busy: `steer` (redirect after current step) or `followUp` (queue) |
| `worker_wait` | Block until the named workers (default: all running/unreported) finish; returns their final answers. Shows live progress while waiting |
| `worker_status` | One line per worker, or a detailed report: latest thinking, recent activity, result |
| `worker_stop` | `abort` the current task (worker stays alive) or `kill` the process; `name: "all"` works |

Workers inherit the manager's model and thinking level unless `model`/`thinking` are given.

## See what workers are doing

| Where | What you see |
|---|---|
| **Widget** (above the editor, automatic) | One row per worker: status, turns, tool calls, context, cost, elapsed time, and the **latest thinking** (💭), current tool call (⟳), or final answer (→) |
| **`/workers [name]`** | Full-screen live viewer: task, streaming **thinking** (┊), output (│), tool calls (▶) and results (✓/✗), retries, compaction, errors. Keys: `←/→` switch worker · `↑/↓ PgUp/PgDn Home/End` scroll · `m` message the worker (steers it if busy) · `a` abort · `k` kill · `esc` close |
| **Log files** | `~/.pi/agent/multi-agent/runs/<time>-<session>/` (and `…/multi-agent/latest`): `<name>.log` (human-readable, streamed live), `<name>.result.md` (last final answer), `<name>.events.jsonl` (lifecycle events with timestamps), `<name>.stderr.log`, `<name>.role.md` |
| **Another terminal** | `scripts/watch.sh` (all workers of the latest run) or `scripts/watch.sh <name>`: `tail -F` of the live logs |
| **Session files** | Each worker saves a normal pi session named `worker:<name>` (path shown in the viewer and in `worker_status`). Open it later with `pi --session <path>`, or browse it in pi-web, including the full thinking |
| **Tool rows** | `worker_wait` streams a live status table while it waits; results render collapsed (`ctrl+o` expands) |

Commands for you: `/workers`, `/worker-send <name> <message>`, `/worker-stop <name|all> [kill]`, `/workers-clear`
(removes finished/killed workers from the list).

In RPC hosts such as pi-web or IDEs, the widget is sent as plain text lines (refreshed about once per second),
and worker dialogs are forwarded through the host's UI.

## Behavior worth knowing

- **Thinking visibility depends on the model/provider.** Pi streams whatever reasoning text the provider returns.
  With `claude-code` models, thinking is adaptive and summarized: you get it for non-trivial work, but
  often none for trivial prompts. Some providers return none, or redacted reasoning.
- **Workers are full pi instances.** They load your settings, packages, skills and AGENTS.md like any pi.
  They do not load the manager tools (the extension disables itself in workers via `PI_MULTI_AGENT_ROLE=worker`),
  so workers cannot spawn workers.
- **Dialogs from workers** (for example a permission prompt from one of your extensions) pop up in the manager UI, prefixed
  `[worker <name>]`. Without a UI (print mode), they are cancelled.
- **Workers live as long as the manager session.** Quitting, `/new`, `/resume`, `/fork` and `/reload` stop all workers
  (abort, then graceful exit, escalating to signals). If the manager dies, workers see stdin EOF and exit.
- **Parallel edits:** there is no cross-process file locking. Give workers disjoint files or modules.
- **Cost:** every worker has its own context and usage. The widget, viewer and `worker_status` show per-worker cost,
  but child usage is not added to the manager's footer totals.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PI_MULTI_AGENT_MAX_WORKERS` | `8` | Max live workers |
| `PI_MULTI_AGENT_DIR` | `~/.pi/agent/multi-agent` | Where run logs go |
| `PI_MULTI_AGENT_WORKER_ARGS` | (none) | Extra CLI args for every worker, split on whitespace. Examples: `--no-session` (no worker session files), `--no-extensions` (lean workers), `--session-dir /path` |

## Files

```
extensions/multi-agent/
  index.ts    tools, commands, widget, auto-notify, session lifecycle
  worker.ts   Worker: spawns `pi --mode rpc`, strict JSONL client, state tracking, logs, dialog forwarding
  ui.ts       widget + /workers live viewer (pi-tui components)
  format.ts   shared formatting
scripts/
  watch.sh          tail worker logs from another terminal
  smoke-worker.ts   test the RPC worker layer without a manager:  node scripts/smoke-worker.ts
```
