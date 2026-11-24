# Observability: thinking, progress, status, results

Everything a worker does is visible in five places, from quickest to most detailed:

| You want | Look at |
|---|---|
| A quick status of all workers | the **widget** above the editor |
| Live thinking, output and tool calls of one worker | **`/workers`** viewer |
| To follow workers from another terminal or keep a record | **log files** + `scripts/watch.sh` |
| Exact timings, costs and tool durations | **`<name>.events.jsonl`** + `jq` |
| The complete transcript later, including full thinking | the worker's **pi session file** (pi or pi-web) |

The manager LLM has its own views too: `worker_status` (one line per worker, or a detailed report with the latest
thinking and recent activity) and the live progress table that `worker_wait` streams while it waits.

## At a glance: what maps where

| | Widget | `/workers` viewer | `<name>.log` | events.jsonl | Session file |
|---|---|---|---|---|---|
| **Thinking** | latest ~line (💭) | full, streamed (┊) | full, streamed (┊) | in `message_end` | full |
| **Progress** (turns, tools) | counts + current tool (⟳) | every tool call + result | every tool call + result | `tool_execution_*` with durations | full |
| **Status** | icon + label + elapsed | header | `━━━━` markers | `agent_settled` | — |
| **Result** | first line (→) | full text | full text (│) | final `message_end` | full |
| **Cost / tokens** | cost, context | turns, ctx, ↑↓, cost | — | `usage` per message | per message |

## Widget

Shown above the editor once the first worker starts. It is hidden while the `/workers` viewer is open.

```
─ workers 0 running · 2 done  ·  /workers to watch live  ·  /workers-legend
 St  Worker            Turns  Tools   Ctx  ↑In  ↓Out     Cost  Time  Now
 ✓   alpha                 2      1  8.2k    4   140  $0.0018   19s  → Master — sleep finished. done …
 ✓   beta-long-name-x      2      1  8.4k    4   312  $0.0019   20s  → Master — ran the requested command chain…
```

The columns are the [status table](reference.md#status-table) columns. Type `/workers-legend` to see the legend
in pi. The `Now` column is a live preview:

- `💭 …` the tail of the current thinking, while the worker is thinking
- `⟳ …` the current activity otherwise (`bash $ npm test`, `waiting for model`, `retry 1/3 …`, `compacting context`,
  `waiting for you: …`)
- `→ …` the start of the final answer, when done
- the error message, on `error` or `crashed`

**Row order.** Running workers come first, in the order they were spawned, so their rows stay put while they work.
Then workers with an error or crash, then finished (done or aborted) ones, then stopped ones; in those groups the
worker that finished most recently comes first. A row moves down when its worker finishes.

**Many workers.** There is no scrollbar. The widget shows up to 8 worker rows (`PI_MULTI_AGENT_WIDGET_ROWS`) and
folds the rest into one line that says what is hidden:

```
 ●   lesson-worker-8      1      1  2.6k    2    80  $0.0005   59s  ⟳ bash $ sleep 90
 … 2 more (2 running)  ·  /workers to see all
```

Because running workers sort first, the hidden ones are normally finished or stopped. They are hidden only when more
workers are running than there are rows. `/workers` reaches every worker; `/workers-clear` removes stopped ones.

In RPC hosts (pi-web, IDE integrations) the widget is sent as plain text and refreshed about once per second.

In fullscreen mode, click a worker row to open the viewer on that worker. See [Mouse](reference.md#mouse).

## `/workers` viewer

```
  ● alpha   [ beta ] ● running  worker 2/2
 1 turns · 0 tools · ctx 4.1k · ↑2 ↓1.3k · $0.03 · 12s
 claude-code/default (high) · log: ~/.pi/agent/multi-agent/runs/…/beta.log
 ⟳ thinking
──────────────────────────────────────────────────────────────
▣ TASK
  Without using any tools, work out how many prime numbers lie between 2000 and 2100…
┊ I'm listing the primes between 2000 and 2100 and counting them to get 14…
┊ I'm checking the trial divisions for 2027 against primes up to 43…
│ **There are 14 primes between 2000 and 2100.**
▶ bash $ npm test
  ✓ (2.3s) 42 passing
──────────────────────────────────────────────────────────────
 ←/→ or click tab · ↑/↓ PgUp/PgDn wheel scroll · End follow · m message · a abort · k kill · esc close
```

The first line is a tab bar, one tab per worker. In fullscreen mode, click a tab to switch, use the wheel to scroll,
and click an action on the last line.

When the tabs do not fit, the bar shows a window of them that always contains the current worker, with `‹ N` and
`N ›` counting the hidden tabs on each side (click one to step to that side). The window moves only when the current
tab would leave it:

```
 ‹ 4    ● lesson-worker-5     ● lesson-worker-6     ● lesson-worker-7     ● lesson-worker-8   [ lesson-worker-9 ] ● running  1 ›  worker 9/10
```

- The header shows status, stats, model and thinking level, the log path, and the current activity or error.
- The body follows live output; scrolling up pauses following (`⏸ scrolled N`), and `End` resumes it.
- Legend: `▣` task · `✉` message you or the manager sent · `┊` thinking · `│` answer text · `▶` tool call ·
  `✓`/`✗` tool result (first lines) · `•` info (retries, compaction, notifications) · `✗` errors.
- The viewer keeps the last 400 entries per worker in memory. The log file keeps everything.

Open it on a specific worker with `/workers <name>` (Tab completes names). All keys are listed in the
[Reference](reference.md#viewer-keys).

## Results in the manager

A finished worker's result reaches the manager as a `⚑ worker <name> <status>` message (auto-report), or in the
`worker_wait` tool row. Both are rendered: the status table is drawn, the result is shown as Markdown, and the
`<worker>`/`<result>` tags the LLM sees are hidden. `ctrl+o` expands the result.

```
⚑ worker be-lesson done
┌────┬───────────┬───────┬───────┬──────┬─────┬──────┬─────────┬──────┬─────┐
│ St │ Worker    │ Turns │ Tools │ Ctx  │ ↑In │ ↓Out │ Cost    │ Time │ Now │
├────┼───────────┼───────┼───────┼──────┼─────┼──────┼─────────┼──────┼─────┤
│ ✓  │ be-lesson │ 1     │ 0     │ 2.7k │ 2   │ 121  │ $0.0006 │ 2s   │     │
└────┴───────────┴───────┴───────┴──────┴─────┴──────┴─────────┴──────┴─────┘

 Summary

 - Scope: Report generated without any tool calls, as requested.
 - Format: Uses a heading, a bullet list, and a table.
 - Status: Complete.
 … 7 more lines (ctrl+o to expand)
 log: ~/.pi/agent/multi-agent/runs/2026-11-24-14-30-57-01a20df7/be-lesson.log
```

`worker_status`, the `worker_wait` progress table and other worker tool rows draw their status tables the same way,
and keep the legend's alignment. The exact rules are in the [Reference](reference.md#result-format).

## Log files

Each manager session that spawns workers gets a run directory. `latest` always points to the newest one:

```bash
ls ~/.pi/agent/multi-agent/latest/
# alpha.log  alpha.events.jsonl  alpha.result.md  alpha.stderr.log  beta.log  …
```

`<name>.log` is written live, so `tail -f` shows thinking and output as they stream:

```
████ 3:33:47 AM worker "counter" starting
cwd: /path/to/project
cmd: …/node …/pi --mode rpc --name worker:counter --model claude-code/default --thinking low --tools bash,read
model: claude-code/default (thinking low)
session: ~/.pi/agent/multi-agent/sessions/2026-11-23T20-33-47-420Z_….jsonl

━━━━ 3:33:47 AM TASK ━━━━
Count the .ts files under the extensions/ directory … Reply with just the number.

── turn 1 ──

▶ bash $ find extensions -type f -name '*.ts' | wc -l
  ✓ (0.0s) 4

── turn 2 ──

│ 4

━━━━ 3:33:51 AM IDLE after 3.4s ━━━━

████ 3:33:52 AM stopped: pi exited (code 0, signal none)
```

The full marker list is in the [Reference](reference.md#namelog-markers).

Follow logs from another terminal:

```bash
scripts/watch.sh            # all workers of the latest run
scripts/watch.sh beta       # one worker
scripts/watch.sh -l         # list runs, newest first
```

`watch.sh` (no name) picks up the workers that exist when you start it. Re-run it to include workers spawned later.

Other files per worker:

- `<name>.result.md`: the final answer of the most recent task. Use this when a tool result says the answer was
  truncated.
- `<name>.stderr.log`: the worker's stderr. Check here first when a worker fails to start or crashes.
- `<name>.role.md`: the role prompt it was started with, if any.

## Event log + jq

`<name>.events.jsonl` has one compact JSON event per line, with `t` = epoch milliseconds. The stored fields are
listed in the [Reference](reference.md#nameeventsjsonl). Some useful queries:

```bash
cd ~/.pi/agent/multi-agent/latest

# Tool calls with durations and errors
jq -c 'select(.type=="tool_execution_end") | {tool: .toolName, ms: .durationMs, error: .isError}' beta.events.jsonl

# Cost, tokens and stop reason per model response
jq -c 'select(.type=="message_end" and .message.role=="assistant")
       | {model: .message.model, stop: .message.stopReason, out: .message.usage.output, cost: .message.usage.cost.total}' beta.events.jsonl

# Total cost of one worker
jq -s '[.[] | select(.type=="message_end" and .message.role=="assistant") | .message.usage.cost.total] | add' beta.events.jsonl

# Total cost of every worker in the run
for f in *.events.jsonl; do printf '%-12s ' "${f%.events.jsonl}"; jq -s '[.[] | select(.type=="message_end" and .message.role=="assistant") | .message.usage.cost.total] | add' "$f"; done

# Thinking text of each response (when the provider returned any)
jq -r 'select(.type=="message_end" and .message.role=="assistant") | .message.content[] | select(.type=="thinking") | .thinking' beta.events.jsonl

# When each task settled, and whether it was aborted
jq -c 'select(.type=="agent_settled") | {at: (.t/1000|todate), aborted}' beta.events.jsonl

# Retries and compactions
jq -c 'select(.type|test("retry|compaction"))' beta.events.jsonl
```

## Session files (pi, pi-web)

Every worker writes a normal pi session (unless you set `PI_MULTI_AGENT_WORKER_ARGS="--no-session"`), named
`worker:<name>`. This is the most complete record: every message, full thinking blocks, tool calls and results.

```bash
pi --session <path>          # open it read/write in pi (continues that worker's conversation!)
pi --export <path> out.html  # export to HTML and exit
```

The path is shown in the viewer header, in `worker_status <name>` and at the top of `<name>.log`.

Since v0.7.0, new worker sessions are stored in `~/.pi/agent/multi-agent/sessions/`, not in the project's session list.
So `pi -c` and `pi -r` in a project open the manager. They no longer show up in pi-web's list for the project; open
them by path. Older worker sessions stay where they were.

## Thinking

Pi streams whatever reasoning the provider returns. Whether you see thinking depends on the model:

- **Models with adaptive or summarized thinking** (e.g. the `claude-code` provider's Claude models) think when the
  task needs it. On non-trivial tasks you see streamed thinking summaries. On trivial prompts there may be none.
  Verified: a `thinking: xhigh` prime-counting task streamed thinking, but a trivial "reply pong" did not.
- **Models without thinking** (`thinking: no` in `pi --list-models`) never show any. Pi clamps the level to `off`.
- **Redacted reasoning** appears as `[redacted thinking]`.
- `thinking: "off"` disables it for that worker.

To check whether a response really had no thinking, look at the events or session file:

```bash
jq -c 'select(.type=="message_end" and .message.role=="assistant") | [.message.content[].type]' beta.events.jsonl
# ["thinking","text"]  ← thinking present
# ["text"]             ← provider returned none
```

## Status meanings

`starting` → `running` → `done` (idle) is the normal path. `error`, `aborted`, `stopped` and `crashed` are explained in
the [Reference](reference.md#worker-statuses). To dig into a problem, see the [Runbook](../RUNBOOK.md#troubleshooting).
