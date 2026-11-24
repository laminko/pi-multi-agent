# Reference

Exact reference for v0.6.0: tools, commands, keys, statuses, files, limits and environment variables.
For how to use them, see the [User Guide](user-guide.md).

- [Tools](#tools)
- [Result format](#result-format)
- [Slash commands](#slash-commands)
- [Viewer keys](#viewer-keys)
- [Worker statuses](#worker-statuses)
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

While waiting, it streams a status table about once per second. The wait ends early in two cases. The workers
keep running in both:

- **You type a message** (outcome `interrupted`). The wait checks `ctx.hasPendingMessages()` on each 400 ms poll.
  It returns in under 1 s, and the manager then reads your message. It can pass the message on with `worker_send`.
- **You press `Esc`** (outcome `aborted`).

On timeout, interrupt or cancel, finished workers are reported and running ones are listed with their current
activity. Running workers auto-notify later. The same early return applies to `worker_spawn` and `worker_send`
with `wait: true`.

### `worker_status`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `name` | string | none | Without it: the [status table](#status-table) with its legend, plus the run directory. With it: a detailed report. |

The detailed report contains: status table and legend · model, thinking level, task count, pid · session file · log file ·
latest thinking (if busy) · last 15 transcript entries (240 chars each) · last result (if not busy). It is truncated
to 40 KB.

### `worker_stop`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `name` | string | **required** | A worker name, or `all` (all live workers). |
| `mode` | `abort` \| `kill` | `abort` | `abort`: cancel the current task; the worker stays alive. `kill`: terminate the process. |

Stopping marks the worker as reported, so it does not auto-notify.

## Result format

`worker_wait`, `worker_spawn`/`worker_send` with `wait: true`, and auto-notifications return one block per worker:

```
<worker name="beta" status="done">
| St | Worker | Turns | Tools |  Ctx | ↑In | ↓Out |  Cost | Time | Now |
|----|--------|------:|------:|-----:|----:|-----:|------:|-----:|-----|
| ✓  | beta   |     1 |     0 | 4.1k |   2 | 1.3k | $0.03 |  12s |     |
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
| ●  | worker-1 |    27 | 37 (2✗) | 99k |  56 |  22k | $1.55 | 15m27s | waiting for model |
| ✓  | worker-2 |    27 | 33 (1✗) | 93k |  56 |  18k | $1.45 | 12m11s |                   |
```

| Column | Meaning | Source |
|---|---|---|
| St | `●` running · `✓` done (internal status `idle`) · `◌` starting · `■` aborted · `✗` error/crashed · `○` stopped | `STATUS_ICON` |
| Worker | Name. `(+n queued)` = n steer or follow-up messages wait in the worker | `queue_update` |
| Turns | Model calls, one per `turn_start` | `worker.ts`, `turns` |
| Tools | Tool calls. `(n✗)` = n returned an error | `tool_execution_start` / `_end` |
| Ctx | Context size now: the total tokens of the last model call | `usage.totalTokens` |
| ↑In | Input tokens not served from cache, summed | `usage.input` |
| ↓Out | Output tokens, thinking included, summed | `usage.output` |
| Cost | USD, summed | `usage.cost.total` |
| Time | Time used by the current task (or the last one, when done) | `taskStartedAt` |
| Now | Current activity while busy; the error text on `error` or `crashed`. The widget shows `→ result` when done | `activity` |

Turns, Tools, ↑In, ↓Out and Cost add up over the **whole life** of the worker. They are not reset per task. Time
is per task.

## Slash commands

| Command | Effect |
|---|---|
| `/workers [name]` | Opens the live viewer (TUI). Without a TUI, shows the status table as a notification. Tab-completes worker names. |
| `/workers-legend` | Shows the [status table](#status-table) and the legend of each column. |
| `/worker-send <name> <message>` | Sends a message as you. Steers the worker if busy, otherwise starts a new task. When it finishes, the manager is auto-notified. |
| `/worker-stop <name\|all> [kill]` | Aborts the current task, or with `kill` terminates the worker. |
| `/workers-clear` | Removes **stopped and crashed** workers from the list and widget. Live workers, including idle ones, stay. Log files are kept. |

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

`idle`, `error` and `aborted` workers are alive and accept `worker_send`. `stopped` and `crashed` workers do not;
spawn a new one (the same name can be reused).

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
| `message_start` | `{type, role}` |
| `message_end` (system message) | `{type, role: "system"}` |
| `message_end` (other roles) | full event: the complete message, including thinking blocks and usage |
| `turn_end` | `{type, stopReason, toolResults: <count>}` |
| `agent_end` | `{type, willRetry, messages: <count>}` |
| everything else | full event (`tool_execution_start/end`, `agent_settled`, `auto_retry_*`, `compaction_*`, `queue_update`, …), plus the RPC `response` and `extension_ui_request` records |

### Worker session files

Each worker is a normal pi session named `worker:<name>`, stored in pi's normal session directory for the
worker's cwd. Its path is shown in the viewer header, `worker_status <name>` and at the top of `<name>.log`.
To turn this off, set `PI_MULTI_AGENT_WORKER_ARGS="--no-session"`.

## Environment variables

These are read when the manager loads the extension.

| Variable | Default | Meaning |
|---|---|---|
| `PI_MULTI_AGENT_MAX_WORKERS` | `8` | Maximum number of live (not stopped/crashed) workers |
| `PI_MULTI_AGENT_WIDGET_ROWS` | `8` | Maximum worker rows in the widget; the rest fold into one `… N more` line |
| `PI_MULTI_AGENT_DIR` | `<pi agent dir>/multi-agent` | Root for run directories |
| `PI_MULTI_AGENT_WORKER_ARGS` | none | Extra CLI args for every worker, split on whitespace (no quoting). E.g. `--no-session`, `--session-dir /path`, `--no-extensions` |

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
| Default `worker_wait` / `wait: true` timeout | 1800 s |
| Tool result size | 40 KB (shared across reported workers, ≥ 2 KB each) |
| In-memory transcript (viewer) | last 400 entries, 20,000 chars per entry (the `.log` keeps everything) |
| Widget rows | 8 workers (`PI_MULTI_AGENT_WIDGET_ROWS`), then one `… N more (<count per status>)` line. Order: running (spawn order), error/crashed, done/aborted, stopped; the last three newest first |
| Widget refresh | ≤ every 100 ms (TUI), ≤ every 1 s (RPC hosts), plus a 1 s tick while workers run |
| Shutdown escalation | abort if busy (≤ 5 s) → close stdin (wait 3 s) → SIGTERM (2 s) → SIGTERM again (2 s; pi exits at once) → SIGKILL |
