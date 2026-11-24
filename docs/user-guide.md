# User Guide

How to run a manager pi with worker pis, and get good results from them.
Exact parameters are in the [Reference](reference.md). For watching workers, see [Observability](observability.md).

## Mental model

- The **manager** is your normal interactive pi session with this extension loaded. You talk to it.
- A **worker** is a separate pi process (`pi --mode rpc`) that the manager starts. It has **its own context
  window**, model, thinking level, tools and optional role prompt. It does **not** see the manager's conversation.
- Workers are **long-lived**. After finishing a task, a worker stays alive with its context, so it can be given
  follow-up work. It stays until you kill it or the manager session ends.
- Workers run **in parallel** with each other and with the manager.
- **You can always talk to the manager.** After it spawns workers, it ends its turn. It does not block.
- Results are **delivered automatically**. You get a toast (`Worker <name> done`), and the manager gets the
  result as a message, takes a turn and reports it to you.
- The manager calls `worker_wait` only when you ask it to wait. If you type while it waits, the wait stops within
  1 s, and the manager reads your message. The workers keep running.

## Install and enable

```bash
# one session only (nothing is written to settings)
pi -e git:github.com/laminko/pi-multi-agent

# always (writes ~/.pi/agent/settings.json)
pi install git:github.com/laminko/pi-multi-agent

# only in the current project (writes .pi/settings.json; requires project trust)
pi install -l git:github.com/laminko/pi-multi-agent

# update, or remove again
pi update git:github.com/laminko/pi-multi-agent
pi remove git:github.com/laminko/pi-multi-agent
```

After `pi install`, a running pi picks the extension up on `/reload`. Note that reloading stops any running workers
(busy ones can be resumed). Load only one copy: an installed package plus `pi -e` with a clone makes the tools
conflict. Installing from a clone is in the [Runbook](../RUNBOOK.md#install-upgrade-uninstall).

## Asking the manager to use workers

You don't call the tools yourself; ask in plain language. The manager writes the worker tasks.

**Fan-out / fan-in.** Independent pieces in parallel, then one combined answer:

> Spawn three workers in parallel: one reviews `src/auth/` for security issues (read-only), one finds every place
> we parse dates and lists the formats used, one checks `docs/` for examples that no longer match the code.
> When all three are done, give me a combined, prioritized list.

Say "wait for all three" only if you want the manager to block. You can still interrupt it by typing.

**Pipeline.** Each stage feeds the next. The manager passes results along:

> Use a read-only worker to map how sessions are persisted. Then give its findings to a second worker that
> implements the Redis cache. When that's done, have the first worker review the diff.

**Long-lived specialist.** Reuse a worker that already has context:

> Keep the `api-expert` worker around. Whenever I ask an API question, send it to that worker with worker_send.

**Mixed models.** Cheap and fast for scouting, strong for the hard part:

> Spawn a scout on a fast model with thinking off to list all call sites of `parseConfig`, then a worker on
> the strongest model with thinking high to redesign it.

**Fire and forget** (the default). The manager keeps talking with you while workers run:

> Start a worker to run the full test suite and summarize failures. Meanwhile, let's discuss the API.

The result shows up as a toast and a `⚑ worker … done` message, and the manager reports it to you.

**Redirect a running worker through the manager.** Just say it:

> Tell the crawlers to be gentle: one request at a time, 5–15 s between pages.

The manager calls `worker_send` with `mode: "steer"`. This works even if the manager was in `worker_wait`.

## Writing good worker tasks

The manager writes the tasks, but you can tell it how. Good tasks:

1. **Are self-contained.** Include the goal, background and relevant file paths. The worker starts with an empty
   context (plus your AGENTS.md and skills, like any pi).
2. **Define "done"** and the **output format**, e.g. "Reply with a markdown table: file, line, issue, severity".
3. **State constraints**: "read-only", "only touch `src/api/`", "don't run the full test suite".
4. **Keep work separable.** There is no file locking between workers, so give each worker its own files or modules.

Useful `worker_spawn` options:

| Want | Use |
|---|---|
| A read-only reviewer or researcher | `tools: "read,grep,find,ls"` and a `role` like "You are a read-only reviewer. Never modify files." |
| A cheaper or faster worker | `model: "<fast model>"`, `thinking: "off"` or `"low"` |
| Deeper reasoning | `thinking: "high"` or `"xhigh"` |
| Work in another repo or directory | `cwd: "../other-repo"` |
| A blocking call that returns the result directly | `wait: true` |
| No automatic result message | `notify: false` (then use `worker_wait`) |

Note: the tools allowlist limits which tools the model can call, but it is **not a sandbox**. A worker with `bash`
can do anything your user can.

## Stepping in yourself

You can talk to workers directly, without going through the manager.

| Want | Do |
|---|---|
| Watch a worker think and work | `/workers` (or `/workers <name>`) |
| Redirect a busy worker | In the viewer press `m`, or run `/worker-send <name> <message>` (steers it) |
| Give an idle worker another task | Same as above (starts a new task) |
| Stop the current task but keep the worker | Viewer `a`, or `/worker-stop <name>` |
| Terminate a worker | Viewer `k`, or `/worker-stop <name> kill` |
| Stop everything | `/worker-stop all kill` |
| Tidy the list | `/workers-clear` (removes stopped and crashed workers) |

When a task you started with `m` or `/worker-send` finishes, the manager is notified too, so it stays in the loop.

## Dialogs from workers

If one of your extensions inside a worker asks a question (confirm, select, input, editor), the dialog appears in
the manager's UI with the title prefix `[worker <name>]`. Answer it as usual. When the manager has no UI (print mode),
worker dialogs are cancelled automatically.

## If a worker gets stuck

The manager watches its workers for you. While any worker runs, it checks each busy one every 10 seconds, without
spending tokens. If a worker has sent nothing for 3 minutes, stops answering, or repeats the same tool call 5 times,
you get a warning toast, the widget shows `⚠` before its activity, and the manager gets an alert. The manager then
follows up on its own: it inspects the worker, and leaves it running (a long build is fine), aborts and re-instructs
it, or kills it. It tells you what it did. If you asked it to wait, the wait ends early so it can follow up.

Tune it before starting pi:

```bash
PI_MULTI_AGENT_HEALTH_INTERVAL=30 pi      # check every 30 s instead of 10 s (0 or off: no checks)
PI_MULTI_AGENT_STALL_SECONDS=600 pi       # call a worker quiet only after 10 min (long builds, slow models)
```

See [Observability](observability.md#stuck-workers-health-checks) for what the warnings mean.

## Controlling cost

- Every worker has its own context and usage. The widget, `/workers` and `worker_status` show cost per worker.
  Child usage is **not** added to the manager's footer totals.
- Use fast models and low thinking levels for scouting. Save the strong settings for the hard step.
- Kill idle workers you no longer need (`/worker-stop <name> kill`). Idle workers cost nothing in tokens, but each
  one counts toward the live-worker limit of 8.
- Ask the manager for concise worker outputs ("max 20 lines"), because results are added to the manager's context.

## If pi quits while workers run

Quitting pi by accident (Ctrl+C, Ctrl+D, closing the terminal) stops every worker; their processes do not keep
running. The work is not lost:

1. Reopen the manager: `pi -c` (or `pi -r` and pick it). Worker sessions are kept in their own directory, so
   `pi -c` finds the manager, not a worker.
2. Every worker that was busy comes back as `↯ interrupted`: in a toast, in the widget, and in `/workers`.
3. Type `/workers-resume`, or just ask the manager ("continue the interrupted workers"); it calls `worker_resume`.
   Each worker restarts **in its own session**, keeps its context, and is told to check what is already done
   before it continues. Its result then arrives like any other.

`/workers-resume <name>` resumes one worker. To drop an interrupted worker instead, use
`/worker-stop <name> kill` or `/workers-clear`.

The same applies after `/reload` and when you `/resume` the manager session later. Details:
[Runbook: Recovering after pi quits](../RUNBOOK.md#recovering-after-pi-quits).

## Lifecycle rules

- Workers run as long as the manager **session**: quitting, `/new`, `/resume`, `/fork` and `/reload` all stop them.
  Workers that were busy can be resumed later, see above.
- If the manager process dies, workers see their stdin close and exit on their own.
- A worker that crashed or was killed cannot be revived. Spawn a new one; reusing the name is fine.
- Worker sessions are saved like any pi session, named `worker:<name>`, in `~/.pi/agent/multi-agent/sessions/`
  (since v0.7.0; before that, in your project's session list). See the [Runbook](../RUNBOOK.md#maintenance) to clean
  them up.

## FAQ

**Can workers spawn their own workers?** No. The extension disables itself inside workers, to avoid runaway trees.

**Can I give a worker a different system prompt entirely?** Not in v0.1.0. `role` is *appended* to pi's normal
system prompt. Full replacement is on the roadmap ([STATUS](../STATUS.md#roadmap)).

**Do workers share files with the manager?** Yes. They run on the same machine and directory (unless `cwd` is
set), with your permissions.

**Why did the manager say a worker may be stuck while it was fine?** A tool call that prints nothing (a long test
run, `sleep`) or a model that thinks for minutes without streaming looks the same as a hang from outside. The
manager checks and normally leaves such a worker running. If your tasks are often silent for long, raise
`PI_MULTI_AGENT_STALL_SECONDS`.

**Why didn't I see any thinking?** It depends on the model; see [Observability](observability.md#thinking).

**Can I reconnect to workers after restarting pi?** Not to the running processes: they end with the session. But
since v0.7.0 you can resume workers that were busy: each continues in its own session, with its context. See
[If pi quits while workers run](#if-pi-quits-while-workers-run).
