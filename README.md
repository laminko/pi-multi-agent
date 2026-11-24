# pi-multi-agent

Let one [pi](https://github.com/earendil-works/pi) session hand work to other pi sessions that run in parallel, each
with its own context, and watch them think while they work.

You keep talking to your pi as usual. When a task splits into independent parts (review this, test that, document
the other), it starts **workers**, keeps answering you while they run, and reports their results when they finish.

```
─ workers 1 running · 1 done  ·  /workers to watch live  ·  /workers-legend
 St  Worker    Turns  Tools  Ctx  ↑In  ↓Out   Cost  Time  Now
 ●   reviewer      3      2  15k    4  1.4k  $0.14   25s  💭 …I'm also flagging that the `__main__` module lacks a guard…
 ✓   tests         4      3  12k   10  6.1k  $0.17   48s  → I wrote `tests/test_todo.py`. It has 39 tests…
```

*The widget above pi's editor during a real run (building a small SQLite todo app): the reviewer is thinking while
the test writer has finished. ↑In counts only input not served from cache, so it stays small next to Ctx (the
context size); `/workers-legend` explains every column.*

## Quick start

You need [pi](https://github.com/earendil-works/pi) with a model that works (`pi --list-models`). It is tested with
pi 1.6.0.

Try it for one session, without installing anything:

```bash
pi -e git:github.com/laminko/pi-multi-agent
```

Or install it, so that every pi session has it (`pi remove git:github.com/laminko/pi-multi-agent` removes it again):

```bash
pi install git:github.com/laminko/pi-multi-agent
```

Then, in a project, ask pi to delegate. You can ask for workers explicitly, as here, or let the manager decide: it
can also use them on its own for work that splits into independent parts.


> Spawn two read-only workers in parallel (tools: read, grep, find, ls). One summarizes what this project does in
> five bullets; the other lists every TODO and FIXME comment with file and line.

What happens next:

1. Your pi, the **manager**, writes a self-contained task for each worker and starts them in parallel.
2. The manager answers right away instead of waiting. A widget above the editor shows each worker's status, cost
   and latest thinking.
3. When a worker finishes, you get a toast and a `⚑ worker … done` message with its result. The manager reads it
   right away (a short extra turn of its own) and reports back.

You can keep talking to the manager while workers run, including to redirect one ("tell the summarizer to focus on
the CLI"). To watch a worker think and work, type `/workers` (see [Watching workers](#watching-workers)).

This prompt cost about $0.24 in total (pi's footer shows only the manager's part; the widget shows each worker's), with `claude-code/default` at thinking level `xhigh`. Ask for a cheaper
model or a lower thinking level for the workers if that matters.

## Watching workers

| Where | What you see |
|---|---|
| **Widget** above the editor (automatic) | One row per worker: status, turns, tool calls, context size, cost, time, and what it is doing now: 💭 its latest thinking, ⟳ its current tool call, or → the start of its result |
| **`/workers [name]`** | A full-screen live view of one worker: its task, thinking as it streams, its answer, every tool call and result. `←`/`→` switch worker, `m` messages it, `a` aborts its task, `k` kills it, `Esc` closes |
| **`⚑ worker … done`** messages | Each result as it arrives: the worker's stats as a table, then its answer rendered as Markdown (`ctrl+o` shows all of it) |
| **Log files** | `~/.pi/agent/multi-agent/latest/<name>.log` is written live, with thinking, answer text and tool calls: `tail -f` it from another terminal |
| **Session files** | Every worker is a normal pi session with its complete transcript, thinking included. The path is in the `/workers` header; open it with `pi --session <path>` |

In pi's fullscreen mode (the default) you can also click: a widget row opens that worker, and the viewer's tabs and
actions are clickable.

More, including `jq` recipes for costs and tool timings: [docs/observability.md](docs/observability.md).

## How it works

- Your pi is the **manager**. Each worker is a separate pi process (`pi --mode rpc`) that the manager starts, with
  its own context, model, thinking level, tools and role. Workers cannot start workers of their own.
- A worker never sees your conversation, so the manager writes each task to stand on its own. A worker stays alive
  after its task, keeps its context, and can take follow-up work until it is killed or the session ends.
- Results come back by themselves. The manager does not wait for workers unless you ask it to.

The manager's model uses these tools; you just ask in plain language:

| Tool | What it does |
|---|---|
| `worker_spawn` | Start a worker with a task, and optionally a model, thinking level, tool allowlist (e.g. read-only), role or directory |
| `worker_send` | Give a worker more work, or redirect one that is busy |
| `worker_wait` | Wait for workers and collect their results (only when you ask it to wait) |
| `worker_status` | Show a status table, or one worker's recent activity and latest thinking |
| `worker_stop` | Abort a worker's task, or kill the worker |
| `worker_resume` | Continue workers that were interrupted when pi quit |

And these are yours, to use directly:

| Command | What it does |
|---|---|
| `/workers [name]` | Open the live viewer |
| `/worker-send <name> <message>` | Message a worker yourself (redirects it if busy) |
| `/worker-stop <name\|all> [kill]` | Abort a task, or kill workers |
| `/workers-resume [name ...]` | Continue interrupted workers |
| `/workers-legend` | Status table with an explanation of every column |
| `/workers-clear` | Remove killed, crashed and interrupted workers from the list (cleared interrupted ones can no longer be resumed) |

Every parameter and default is in [docs/reference.md](docs/reference.md); prompting patterns are in the
[user guide](docs/user-guide.md).

## If pi quits

Quitting pi or closing its terminal, by accident or not, stops all workers. Their work is not lost:

1. Reopen the session with `pi -c` (or pick it with `pi -r` if you have used pi in that directory since). Workers
   that were busy show up as `↯ interrupted`. Workers that had already finished come back only as their results:
   their processes are gone, and the manager starts new workers if it needs them.
2. Type `/workers-resume`, or ask the manager to continue them.

Each worker continues in its own session, with its context, and checks what is already done before it goes on. It
redoes the step it was in, so look at `git status` first if workers were editing files.

## Good to know

- **Thinking shows only if the model returns it.** Models with adaptive thinking think on real work, but often not
  on trivial prompts. Some models never return thinking.
- **Workers share your files with no locking.** Two workers editing the same file can overwrite each other's
  changes, so give parallel workers separate files or modules.
- **Every worker costs like a separate session.** The widget shows the cost per worker; it is not added to the
  manager's footer.
- **The tool allowlist is not a sandbox.** Without an allowlist a worker gets pi's default tools, `bash` included. A
  worker can only call the tools in its list, so one without `bash`, `write` and `edit` cannot change files. But a
  worker with `bash` can do anything you can.
- **At most 8 live workers** by default (`PI_MULTI_AGENT_MAX_WORKERS`). Finished workers stay alive for follow-up
  work and count too; `/worker-stop <name> kill` frees a slot.

**Status:** v0.7.0, a working prototype. Tested on macOS with pi 1.6.0; Linux should work, Windows is untested. There
is no CI yet. What is verified and what is not: [STATUS.md](STATUS.md).

## Documentation

| Document | Read it for |
|---|---|
| [User guide](docs/user-guide.md) | How to prompt the manager, writing good worker tasks, stepping in, cost, FAQ |
| [Observability](docs/observability.md) | Thinking, progress, status and results in detail: widget, viewer, logs, `jq` recipes |
| [Reference](docs/reference.md) | Every tool, parameter, default, command, key, status, file, environment variable and limit |
| [Architecture](docs/architecture.md) | How it works inside, and why |
| [Runbook](RUNBOOK.md) | Install, smoke tests, troubleshooting, recovery, maintenance |
| [Status](STATUS.md) and [changelog](CHANGELOG.md) | What is done and verified, known issues, roadmap, history |

### Development

The extension is TypeScript that pi loads directly; there is no build step. To work on it, clone the repository and
load your copy with `pi -e ./extensions/multi-agent/index.ts`. Remove an installed copy first
(`pi remove git:github.com/laminko/pi-multi-agent`); otherwise both copies register the same tools and one of them
fails to load. The checks below make no model calls, take about a second each, and need Node.js 22.18 or newer. Run
them from the repository root; each prints `PASS`/`FAIL` lines and exits non-zero if anything fails:

```bash
node scripts/test-ui-overflow.ts
node scripts/test-render-report.ts
node scripts/test-resume.ts
```

The end-to-end tests that do call a model are listed in the [runbook](RUNBOOK.md#smoke-tests).

## License

[MIT](LICENSE)
