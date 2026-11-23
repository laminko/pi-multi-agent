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
- Results flow back in one of two ways: the manager calls `worker_wait`, or, if nobody is waiting, the result is
  **delivered automatically** as a message and the manager takes another turn to handle it.

## Install and enable

```bash
# one session only
pi -e /path/to/pi-multi-agent/extensions/multi-agent/index.ts

# always (writes ~/.pi/agent/settings.json)
pi install /path/to/pi-multi-agent

# only in the current project (writes .pi/settings.json; requires project trust)
pi install -l /path/to/pi-multi-agent

# remove again
pi remove /path/to/pi-multi-agent
```

After `pi install`, a running pi picks the extension up on `/reload`. Note that reloading stops any running workers.

## Asking the manager to use workers

You don't call the tools yourself; ask in plain language. The manager writes the worker tasks.

**Fan-out / fan-in.** Independent pieces in parallel, then one combined answer:

> Spawn three workers in parallel: one reviews `src/auth/` for security issues (read-only), one finds every place
> we parse dates and lists the formats used, one checks `docs/` for examples that no longer match the code.
> Wait for all three, then give me a combined, prioritized list.

**Pipeline.** Each stage feeds the next. The manager passes results along:

> Use a read-only worker to map how sessions are persisted. Then give its findings to a second worker that
> implements the Redis cache. When that's done, have the first worker review the diff.

**Long-lived specialist.** Reuse a worker that already has context:

> Keep the `api-expert` worker around. Whenever I ask an API question, send it to that worker with worker_send.

**Mixed models.** Cheap and fast for scouting, strong for the hard part:

> Spawn a scout on a fast model with thinking off to list all call sites of `parseConfig`, then a worker on
> the strongest model with thinking high to redesign it.

**Fire and forget.** The manager keeps talking with you while workers run:

> Start a worker to run the full test suite and summarize failures. Don't wait. Meanwhile, let's discuss the API.

The result shows up as a `⚑ worker … done` message, and the manager reacts to it automatically.

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

## Controlling cost

- Every worker has its own context and usage. The widget, `/workers` and `worker_status` show cost per worker.
  Child usage is **not** added to the manager's footer totals.
- Use fast models and low thinking levels for scouting. Save the strong settings for the hard step.
- Kill idle workers you no longer need (`/worker-stop <name> kill`). Idle workers cost nothing in tokens, but each
  one counts toward the live-worker limit of 8.
- Ask the manager for concise worker outputs ("max 20 lines"), because results are added to the manager's context.

## Lifecycle rules

- Workers end with the manager **session**: quitting, `/new`, `/resume`, `/fork` and `/reload` all stop them.
- If the manager process dies, workers see their stdin close and exit on their own.
- A worker that crashed or was killed cannot be revived. Spawn a new one; reusing the name is fine.
- Worker sessions are saved like any pi session, named `worker:<name>`, and appear in your session list for that
  directory. See the [Runbook](../RUNBOOK.md#maintenance) to turn this off or clean them up.

## FAQ

**Can workers spawn their own workers?** No. The extension disables itself inside workers, to avoid runaway trees.

**Can I give a worker a different system prompt entirely?** Not in v0.1.0. `role` is *appended* to pi's normal
system prompt. Full replacement is on the roadmap ([STATUS](../STATUS.md#roadmap)).

**Do workers share files with the manager?** Yes. They run on the same machine and directory (unless `cwd` is
set), with your permissions.

**Why didn't I see any thinking?** It depends on the model; see [Observability](observability.md#thinking).

**Can I reconnect to workers after restarting pi?** Not in v0.1.0. The processes end with the session. Their
transcripts remain in the logs and session files.
