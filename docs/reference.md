# Reference

Exact reference for v0.8.0: tools, commands, keys, statuses, health checks, files, limits and environment variables.
For how to use them, see the [User Guide](user-guide.md).

- [Tools](#tools)
- [Result format](#result-format)
- [Slash commands](#slash-commands)
- [Viewer keys](#viewer-keys)
- [Worker statuses](#worker-statuses)
- [Health checks](#health-checks)
- [Files](#files)
- [Environment variables](#environment-variables)
- [Limits and timeouts](#limits-and-timeouts)

## Tools

The manager LLM gets these tools. They are registered only in the manager: inside workers, the
extension disables itself (`PI_MULTI_AGENT_ROLE=worker`).

### `worker_spawn`

Starts a new worker process and sends it `task` as its first prompt.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `name` | string | **required** | Sanitized to `[A-Za-z0-9_-]`, max 40 chars. Must not match a live worker. A dead worker with the same name is replaced. |
| `task` | string | **required** | The worker cannot see the manager's conversation, so this must be self-contained. |
| `role` | string | none | Saved to `<run>/<name>.role.md` and passed as `--append-system-prompt`. |
| `model` | string | manager's `provider/id` | Passed as `--model`. Accepts pi model patterns, e.g. `sonnet` or `provider/id:high`. |
| `thinking` | `off` `minimal` `low` `medium` `high` `xhigh` `max` | manager's level, **only when `model` is omitted** | Passed as `--thinking`. If `model` is set and `thinking` is not, the model's default applies. |
| `tools` | string | pi's default tools | Comma-separated allowlist, passed as `--tools` (e.g. `read,grep,find,ls`). |
| `cwd` | string | manager's cwd | Relative paths resolve against the manager's cwd. Must exist. |
| `wait` | boolean | `false` | `true`: block until the worker settles and return its result. |
| `notify` | boolean | `true` | Auto-deliver the result to the manager when the worker finishes and nobody is waiting on it. The user also gets a toast, `Worker <name> <status>`, for every finished task (with or without `notify`). |
| `timeoutSeconds` | number | `1800` | Only with `wait: true`. |

Returns, without `wait`: `Started worker "<name>" (pid, model, thinking)` plus the live log path, and a hint
that tells the manager not to wait. The manager then ends its turn, so you can talk to it while the worker runs.
With `wait`: a [result block](#result-format).

Errors: the name belongs to a live worker · the live worker limit is reached · `cwd` does not exist · the worker failed
to start (message includes the stderr tail) · the first prompt was rejected.

### `worker_send`

Messages an existing, live worker.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `name` | string | **required** | |
| `message` | string | **required** | |
| `mode` | `steer` \| `followUp` | `followUp` | Used only when the worker is busy. `steer`: delivered after its current step. `followUp`: delivered when it would otherwise stop. |
| `wait` | boolean | `false` | Block until the worker settles. |
| `timeoutSeconds` | number | `1800` | Only with `wait: true`. |

If the worker is idle, the message starts a new task. The worker keeps its earlier context, and its previous result
is cleared. Errors: unknown worker · worker not alive (stopped or crashed).

### `worker_wait`

Waits until workers settle, then returns their [result blocks](#result-format) and marks them reported.
The manager is told to call it only when you ask it to wait. By default, results arrive by auto-notify.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `names` | string[] | see below | Workers to wait for. |
| `timeoutSeconds` | number | `1800` | |

Default targets: every busy worker, plus every finished worker whose result has not been reported yet (and that is
not being stopped). With no targets, it returns the status of all workers immediately.

While waiting, it streams a status table about once per second. The wait ends early in three cases. The workers
keep running in all of them:

- **You type a message** (outcome `interrupted`). The wait checks `ctx.hasPendingMessages()` on each 400 ms poll.
  It returns in under 1 s, and the manager then reads your message. It can pass the message on with `worker_send`.
- **You press `Esc`** (outcome `aborted`).
- **A [health check](#health-checks) alerts about a waited-for worker** (outcome `stalled`). The result starts
  with `Wait stopped early: the health check found N worker(s) that may be stuck`, then each one's headline and what
  to do. The alert comes with the wait instead of as a separate message. Only a new alert counts: a worker that was
  already flagged when the wait began stops it at its next repeat alert.

On timeout, interrupt or cancel, finished workers are reported and running ones are listed with their current
activity. Running workers auto-notify later. The same early return applies to `worker_spawn` and `worker_send`
with `wait: true`.

### `worker_status`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `name` | string | none | Without it: the [status table](#status-table) with its legend, plus the run directory. With it: a detailed report. |

The detailed report contains: status table and legend · model, thinking level, task count, pid · session file · log file ·
health line (if busy: verdict, time since the last output, time since the last status check reply) · latest thinking
(if busy) · last 15 transcript entries (240 chars each) · last result (if not busy). It is truncated to 40 KB.
Without a name, the table is followed by the run directory (`logs: …`) and the health check settings
(`health checks: every 10s while workers run · …`).

### `worker_stop`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `name` | string | **required** | A worker name, or `all` (all live workers). |
| `mode` | `abort` \| `kill` | `abort` | `abort`: cancel the current task; the worker stays alive. `kill`: terminate the process. |

Stopping marks the worker as reported, so it does not auto-notify. On an `interrupted` worker, `kill` dismisses it:
it is no longer offered for resume.

### `worker_resume`

Continues workers that were busy when pi quit (status `interrupted`).

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `names` | string[] | all interrupted workers | |

For each worker:

1. If its old process still runs (the manager was killed hard, so the worker never got a shutdown), it is skipped
   with a message. Two pi processes must not write the same session file.
2. If its session ends with tool calls that have no result (pi quit while a tool call was being made), each gets an
   error result `Not run: the session was interrupted …`. Providers reject a conversation with unanswered tool calls.
3. A new worker process opens the **same session file** (`--session`) with the recorded model, thinking level,
   tools, role, cwd and `notify`, and gets the prompt: *"You were interrupted … Continue your task from where you
   stopped. First check what is already done …"*.
4. Without a session file (for example `--no-session` in `PI_MULTI_AGENT_WORKER_ARGS`), it starts fresh with its
   recorded task plus a note that an earlier attempt was interrupted.

Returns one line per worker (`resumed in its own session`, `had no session file, so it restarted its task`, or why
not). Results then arrive like any worker's.

## Result format

`worker_wait`, `worker_spawn`/`worker_send` with `wait: true`, and auto-notifications return one block per worker:

```
<worker name="beta" status="done">
| St | Worker | Turns | Tools |  Ctx | ↑In | ↓Out |  Cost | Time | Now |
|----|--------|------:|------:|-----:|----:|-----:|------:|-----:|-----|
| ✓  | beta   |     1 |     0 | 0.4% |   2 | 1.3k | $0.03 |  12s |     |
<result>
…final assistant text of the task…
</result>
(full transcript log: ~/.pi/agent/multi-agent/runs/<run>/beta.log)
</worker>
```

- `status` is a label from [Worker statuses](#worker-statuses). For `error` and `crashed`, an `error: …` line follows
  the table. Result blocks omit the legend, to save tokens.
- The result is the text of the **last assistant message that contained text** during the task, or
  `(no final text output)` if there was none.
- **Size budget:** 40 KB per tool result, split evenly across the reported workers (minimum 2 KB each). Truncated
  results end with `[result truncated …; full text: <run>/<name>.result.md]`.
- Still-running workers (after a timeout or cancel) appear as `<worker name="…" status="running">` with their
  status table row.

**Display in the TUI** (since v0.6.0). The text above is what the manager LLM gets, unchanged. Tool rows and
`⚑ worker …` messages show it rendered (`extensions/multi-agent/report.ts`):

| Part | Shown as |
|---|---|
| `<worker>`, `<result>` tags | hidden |
| status table | a drawn table |
| result | Markdown; collapsed: first 6 lines and `… N more lines (ctrl+o to expand)` |
| `error: …` | red; collapsed: first 14 lines |
| `(full transcript log: …)` | `log: ~/…` (dim) |
| text outside blocks (notes, legend, `logs:`) | as is, line breaks and alignment kept; collapsed: first 14 lines. Status tables inside it are drawn |

A block that does not parse (for example cut off) is shown as plain text. Errors thrown by a tool stay plain red text.

## Status table

The default status format, since v0.3.0. `worker_status`, the `worker_wait` progress, `/workers` without a TUI and
`/workers-legend` print it with its legend. The TUI widget uses the same columns.

```
| St | Worker   | Turns |   Tools | Ctx | ↑In | ↓Out |  Cost |   Time | Now               |
|----|----------|------:|--------:|----:|----:|-----:|------:|-------:|-------------------|
| ●  | worker-1 |    27 | 37 (2✗) | 50% |  56 |  22k | $1.55 | 15m27s | waiting for model |
| ✓  | worker-2 |    27 | 33 (1✗) | 47% |  56 |  18k | $1.45 | 12m11s |                   |
```

| Column | Meaning | Source |
|---|---|---|
| St | `●` running · `✓` done (internal status `idle`) · `◌` starting · `■` aborted · `✗` error/crashed · `○` stopped | `STATUS_ICON` |
| Worker | Name. `(+n queued)` = n steer or follow-up messages wait in the worker | `queue_update` |
| Turns | Model calls, one per `turn_start` | `worker.ts`, `turns` |
| Tools | Tool calls. `(n✗)` = n returned an error | `tool_execution_start` / `_end` |
| Ctx | Context used now: the total tokens of the last model call as a share of the model's context window, e.g. `0.4%`, `27%` (`<0.1%` below 0.1; one decimal below 10%). Shown in tokens (`4.1k`) when pi does not report the window. The widget draws it in the warning color from 80%. The viewer and `/workers` stats line show both: `ctx 27% (54k of 200k)` | `usage.totalTokens` / `get_state` `model.contextWindow` |
| ↑In | Input tokens not served from cache, summed | `usage.input` |
| ↓Out | Output tokens, thinking included, summed | `usage.output` |
| Cost | USD, summed | `usage.cost.total` |
| Time | Time used by the current task (or the last one, when done) | `taskStartedAt` |
| Now | Current activity while busy, after a `⚠` [health warning](#health-checks) if there is one; the error text on `error` or `crashed`. The widget shows `→ result` when done | `activity`, `health` |

Turns, Tools, ↑In, ↓Out and Cost add up over the **whole life** of the worker. They are not reset per task. Time
is per task.

## Slash commands

| Command | Effect |
|---|---|
| `/workers [name]` | Opens the live viewer (TUI). Without a TUI, shows the status table as a notification. Tab-completes worker names. |
| `/workers-legend` | Shows the [status table](#status-table) and the legend of each column. |
| `/worker-send <name> <message>` | Sends a message as you. Steers the worker if busy, otherwise starts a new task. When it finishes, the manager is auto-notified. |
| `/worker-stop <name\|all> [kill]` | Aborts the current task, or with `kill` terminates the worker. `kill` on an interrupted worker dismisses it. |
| `/workers-resume [name ...]` | Resumes interrupted workers (default: all), like [`worker_resume`](#worker_resume). Tab-completes interrupted names. |
| `/workers-clear` | Removes **stopped, crashed and interrupted** workers from the list and widget; interrupted ones are dismissed for good. Live workers, including idle ones, stay. Log files are kept. |

## Viewer keys

| Key | Action |
|---|---|
| `←` / `→`, `Shift+Tab` / `Tab` | Previous / next worker |
| `↑` / `↓` | Scroll one line |
| `PgUp` / `PgDn` | Scroll one page |
| `Home` / `End` | Jump to the oldest kept entry / follow live output |
| `m` | Message the worker: steers it if busy, otherwise starts a new task |
| `a` | Abort the worker's current task |
| `k` | Kill the worker (asks for confirmation) |
| `Esc`, `Ctrl+C`, `q` | Close |

When the tabs do not fit the width, the tab bar shows a window of tabs that always contains the current worker, and
`‹ N` / `N ›` count the hidden tabs on each side. The window moves only when the current tab would leave it. `←`/`→`
reach every worker, and wrap around at the ends. The `worker i/N` counter is always visible.

## Mouse

Mouse input works only in pi's fullscreen mode (`tuiMode: "fullscreen"`, the default). In regular mode the terminal
keeps the mouse, so use the keys. Every mouse action also has a key.

| Where | Mouse | Action |
|---|---|---|
| Widget, worker row | Left click | Open the viewer on that worker |
| Widget, summary or column header | Left click | Open the viewer on the first worker |
| Widget, `… N more` line | Left click | Open the viewer on the first hidden worker |
| Viewer, tab bar (line 1) | Left click on a tab | Switch to that worker |
| Viewer, tab bar `‹ N` / `N ›` marker | Left click | Switch to the nearest hidden worker on that side |
| Viewer, any line | Wheel | Scroll the transcript |
| Viewer, help line (last line) | Left click on `End follow`, `m message`, `a abort`, `k kill`, `esc close` | The same as the key |

Right and middle clicks are not used. A drag is not used, so pi's text selection still works.

## Worker statuses

| Status | Icon | Label | Meaning |
|---|---|---|---|
| `starting` | ◌ | starting | Process spawned; waiting for its first RPC response |
| `running` | ● | running | A task is in progress (`busy`) |
| `idle` | ✓ | done | Last task finished normally; ready for more work |
| `error` | ✗ | error | Last task ended with a model/provider error, or the prompt was rejected |
| `aborted` | ■ | aborted | Last task was aborted; the worker is still alive |
| `stopped` | ○ | stopped | Process terminated on purpose (kill, or manager shutdown) |
| `crashed` | ✗ | crashed | Process exited unexpectedly; `errorMessage` holds the exit reason and stderr tail |
| `interrupted` | ↯ | interrupted | Restored when the manager session was reopened: the worker was busy when pi quit. No process; see [`worker_resume`](#worker_resume) |

A health warning (`⚠ quiet 3m05s`, `⚠ not answering`, `⚠ loop ×5`) is not a status: the worker stays `running`.
See [Health checks](#health-checks).

`idle`, `error` and `aborted` workers are alive and accept `worker_send`. `stopped` and `crashed` workers do not;
spawn a new one (the same name can be reused). `interrupted` workers are resumed with `worker_resume`; `worker_send`
refuses them with a hint.

## Health checks

Since v0.8.0 the manager follows up on running workers by itself (`health.ts`). While at least one worker
is busy, it checks every busy worker every `PI_MULTI_AGENT_HEALTH_INTERVAL` seconds (default **10**). A check costs no
model tokens:

1. **Heartbeat.** One RPC `get_state` to the worker, with a timeout of `min(5 s, interval)`. pi answers it at once,
   even mid task, so a missing reply means the process is blocked or hung. The reply's `isStreaming` and
   `isCompacting` are kept. Heartbeat replies are not written to `<name>.events.jsonl`.
2. **Verdict**, from the heartbeat and what the worker already tracks, worst first:

| Verdict | When | Warning in Now | Alerted |
|---|---|---|---|
| `unresponsive` | 3 heartbeats in a row got no reply | `⚠ not answering` | yes |
| `waiting` | a dialog from the worker waits for your answer | none (the activity says `waiting for you: …`) | no: only you can answer it |
| `looping` | 5 tool calls in a row with the same tool and the same arguments | `⚠ loop ×n` | yes |
| `quiet` | no event from the worker for `PI_MULTI_AGENT_STALL_SECONDS` (default **180**) | `⚠ quiet 3m05s` | yes |
| `ok` | otherwise | none | |

"Event" means any session event, streaming deltas included, or a dialog or notification from the worker. Heartbeat
replies do not count. A long tool call without output (`sleep`, a quiet build) or a model that thinks without
streaming are quiet too: the alert says what the worker is doing, and the manager decides.

3. **Alert**, on a new problem:
   - you get a toast: `Worker <name> may be stuck (quiet): no output for 3m02s; now: bash $ npm run dev; …`;
   - the manager LLM gets a message (`customType: "multi-agent-health"`, `deliverAs: "followUp"`,
     `triggerTurn: true`, shown as `⚠ worker <name> may be stuck (…)`). It holds the headline, the worker's status
     table row, the settings, and what to do for that verdict (inspect with `worker_status`; leave a legitimately
     long step running; abort a hung tool call and re-instruct, because steering arrives only after the current
     step; kill a process that does not answer), and asks the manager to tell you what it found and did.
   - No message when the worker has `notify: false` (`worker_wait` and `worker_status` show the health instead), or
     when a `worker_wait` waits on it (the wait returns `stalled` instead).

While the problem lasts, it is alerted again (`is still stuck`) each time it has lasted about twice as long, at least
`PI_MULTI_AGENT_STALL_SECONDS` and 60 s apart: with the defaults at 3, 6, 12, 24 … minutes of quiet. A new problem
(another verdict, a new quiet period, a new loop) alerts at once. When an alerted worker moves again you get a toast
`Worker <name> is making progress again`; the manager gets nothing until the result. The warning in the table goes
away as soon as the worker sends an event, before the next check. Health state resets when a task starts or settles.

`PI_MULTI_AGENT_HEALTH_INTERVAL=0` (or `off`) turns the checks off; `PI_MULTI_AGENT_STALL_SECONDS=0` turns only the
quiet verdict off.

## Idle cleanup

Since v0.9.0, a worker that finished and was not reused for `PI_MULTI_AGENT_IDLE_MINUTES` minutes (default **10**) has
its process stopped (`idle.ts`). Checked about 10 times per idle period (every 1–30 s).

- Never while the worker is busy, starting, has queued messages or an open dialog, or a `worker_wait` waits on it.
  Idle time counts from the end of its last task (or its start, if it never had one).
- The worker stays listed as `○ stopped` with the hint `stopped while idle · worker_send revives it with its
  context` (widget: `idle · worker_send revives · → <result>`, and `N stopped while idle` in the summary). Its
  result, log and session file stay. You get an info toast `Worker <name> stopped after 10m00s idle`;
  the manager LLM gets no message. It no longer counts toward `PI_MULTI_AGENT_MAX_WORKERS`.
- `worker_send` (and `/worker-send`, viewer `m`) starts it again on its own session file, so it keeps its context;
  the reply starts with `It had been stopped for being idle; restarted on its own session…`. Counters and viewer
  history carry over.
- A worker killed on purpose (`worker_stop` mode `kill`, `/worker-stop <name> kill`, viewer `k`) is not revived.
- `worker_status` shows the setting: `idle cleanup: worker processes stop after 10m00s without a task…`.

`PI_MULTI_AGENT_IDLE_MINUTES=0` (or `off`) keeps idle workers alive until the session ends.

## Files

### Run directory

```
${PI_MULTI_AGENT_DIR:-<pi agent dir>/multi-agent}/
├── latest -> runs/<newest run>          (symlink, replaced by every new run)
└── runs/<UTC yyyy-mm-dd-HH-MM-SS>-<first 8 chars of the manager session id>/
    ├── <name>.log            human-readable live transcript
    ├── <name>.events.jsonl   compact event log
    ├── <name>.result.md      final answer of the most recent task
    ├── <name>.stderr.log     worker process stderr
    └── <name>.role.md        role prompt (only if `role` was given)
```

The pi agent dir is `~/.pi/agent`, unless `PI_CODING_AGENT_DIR` overrides it. A run directory is created the first time
a manager session spawns a worker. The timestamp is in UTC.

### `<name>.log` markers

| Marker | Meaning |
|---|---|
| `████` | Process start (with cwd, full command, model, session file) and process exit |
| `━━━━ TASK` / `━━━━ MESSAGE` | A new task or idle-time message, with its full text |
| `━━━━ IDLE/ERROR/ABORTED after Ns` | Task settled |
| `── turn N ──` | Start of a model turn |
| `┊` | Thinking (streamed as it arrives) |
| `│` | Assistant text (streamed) |
| `▶ tool args` | Tool call started |
| `✓ (1.2s) …` / `✗ …` | Tool result: first 3 lines, max 400 chars |
| `✉ STEER:` / `✉ FOLLOWUP:` | Message delivered while busy |
| `•` | Info: notifications, retries, compaction |
| `?` / `→` | Dialog raised by the worker / the response sent back |
| `✗` | Model error, retry failure |

### `<name>.events.jsonl`

One JSON object per line: `{"t": <epoch ms>, ...event}`. These are pi's JSON event stream events (see `docs/json.md`
in the pi docs), made more compact:

| Event | Stored as |
|---|---|
| `message_update`, `tool_execution_update` | dropped (high-volume streaming deltas; they are in the `.log` and the session file) |
| `response` to a health check heartbeat (`get_state`) | dropped (one every 10 s per busy worker) |
| `message_start` | `{type, role}` |
| `message_end` (system message) | `{type, role: "system"}` |
| `message_end` (other roles) | full event: the complete message, including thinking blocks and usage |
| `turn_end` | `{type, stopReason, toolResults: <count>}` |
| `agent_end` | `{type, willRetry, messages: <count>}` |
| everything else | full event (`tool_execution_start/end`, `agent_settled`, `auto_retry_*`, `compaction_*`, `queue_update`, …), plus the RPC `response` and `extension_ui_request` records |

### Worker session files

Each worker is a normal pi session named `worker:<name>`. Since v0.7.0 new workers store it in
`<multi-agent dir>/sessions/` (`--session-dir`; change it with `PI_MULTI_AGENT_WORKER_SESSION_DIR`), so `pi -c` and
`pi -r` in a project find the manager, not a worker. Before v0.7.0 they were stored in pi's normal session directory
for the worker's cwd. Its path is shown in the viewer header, `worker_status <name>` and at the top of `<name>.log`.
To turn sessions off, set `PI_MULTI_AGENT_WORKER_ARGS="--no-session"` (then resume restarts tasks instead of
continuing them). A `--session-dir`, `--session` or `--no-session` in `PI_MULTI_AGENT_WORKER_ARGS` replaces the default.

### Worker records (manager session)

The manager appends a custom entry (`customType: "multi-agent-worker"`, not sent to the model) to **its own**
session whenever a worker's state changes: a task starts (with the task text), a task settles, the process exits.
Nothing is recorded while the manager shuts down, so a worker that was busy at quit keeps `busy: true` as its last
record. When the session is opened again (startup with `-c`/`-r`/`--session`, `/resume`, `/reload`), the records of
the current branch are merged per worker, and the busy ones come back as `interrupted`.

```json
{"v":1,"name":"be-lesson","status":"running","busy":true,"at":1764000000000,
 "options":{"cwd":"/repo","model":"claude-code/default","thinking":"high","tools":"read,bash","notify":true},
 "task":"…","sessionFile":"~/.pi/agent/multi-agent/sessions/….jsonl","pid":12345,"logPath":"…/be-lesson.log"}
```

At the start of the manager's next run, if workers are still interrupted, the model gets a hidden note listing them
and telling it to use `worker_resume` rather than respawning.

## Environment variables

These are read when the manager loads the extension.

| Variable | Default | Meaning |
|---|---|---|
| `PI_MULTI_AGENT_MAX_WORKERS` | `8` | Maximum number of live (not stopped/crashed) workers |
| `PI_MULTI_AGENT_WIDGET_ROWS` | `8` | Maximum worker rows in the widget; the rest fold into one `… N more` line |
| `PI_MULTI_AGENT_DIR` | `<pi agent dir>/multi-agent` | Root for run directories and worker sessions |
| `PI_MULTI_AGENT_WORKER_SESSION_DIR` | `<multi-agent dir>/sessions` | Where new workers store their sessions |
| `PI_MULTI_AGENT_WORKER_ARGS` | none | Extra CLI args for every worker, split on whitespace (no quoting). E.g. `--no-session`, `--session-dir /path`, `--no-extensions` |
| `PI_MULTI_AGENT_HEALTH_INTERVAL` | `10` | Seconds between [health checks](#health-checks) of busy workers. Fractions allowed; below 1 becomes 1. `0` or `off` turns health checks off. Invalid values use the default |
| `PI_MULTI_AGENT_IDLE_MINUTES` | `10` | Minutes a finished worker may stay unused before its process is stopped ([idle cleanup](#idle-cleanup)). Fractions allowed. `0` or `off`: never. Invalid values use the default |
| `PI_MULTI_AGENT_STALL_SECONDS` | `180` | Seconds without any event before a busy worker counts as `quiet` and the manager is alerted. `0` or `off` turns only this verdict off |

Set by the extension on worker processes:

| Variable | Value |
|---|---|
| `PI_MULTI_AGENT_ROLE` | `worker` (disables this extension inside the worker) |
| `PI_MULTI_AGENT_WORKER` | the worker's name |

## Limits and timeouts

| Item | Value |
|---|---|
| Live workers | 8 (`PI_MULTI_AGENT_MAX_WORKERS`) |
| Worker startup (first `get_state` response) | 120 s |
| RPC command response (prompt, steer, follow_up) | 60 s |
| Abort | 30 s |
| Health check interval | 10 s (`PI_MULTI_AGENT_HEALTH_INTERVAL`) |
| Health check heartbeat (`get_state`) reply | `min(5 s, interval)`; 3 unanswered in a row = `unresponsive` |
| Quiet after | 180 s without events (`PI_MULTI_AGENT_STALL_SECONDS`) |
| Loop | 5 identical tool calls in a row |
| Idle worker process stopped after | 10 min without a task (`PI_MULTI_AGENT_IDLE_MINUTES`) |
| Repeat alerts | when the problem has lasted about twice as long; at least the stall time and 60 s apart |
| Default `worker_wait` / `wait: true` timeout | 1800 s |
| Tool result size | 40 KB (shared across reported workers, ≥ 2 KB each) |
| In-memory transcript (viewer) | last 400 entries, 20,000 chars per entry (the `.log` keeps everything) |
| Widget rows | 8 workers (`PI_MULTI_AGENT_WIDGET_ROWS`), then one `… N more (<count per status>)` line. Order: running (spawn order), error/crashed, done/aborted, stopped; the last three newest first |
| Widget refresh | ≤ every 100 ms (TUI), ≤ every 1 s (RPC hosts), plus a 1 s tick while workers run |
| Shutdown escalation | abort if busy (≤ 5 s) → close stdin (wait 3 s) → SIGTERM (2 s) → SIGTERM again (2 s; pi exits at once) → SIGKILL |
