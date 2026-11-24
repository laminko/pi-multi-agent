# Runbook

Operational procedures for pi-multi-agent: install, verify, operate, troubleshoot, maintain.
Commands assume the repo is at `/path/to/pi-multi-agent` and pi's agent dir is `~/.pi/agent`.

- [Cheat sheet](#cheat-sheet)
- [Prerequisites](#prerequisites)
- [Install, upgrade, uninstall](#install-upgrade-uninstall)
- [Smoke tests](#smoke-tests)
- [Operating a session](#operating-a-session)
- [Troubleshooting](#troubleshooting)
- [Emergency stop](#emergency-stop)
- [Maintenance](#maintenance)
- [Collecting a bug report](#collecting-a-bug-report)

## Cheat sheet

| Task | Command |
|---|---|
| Try for one session | `pi -e /path/to/pi-multi-agent/extensions/multi-agent/index.ts` |
| Install for all sessions | `pi install /path/to/pi-multi-agent` |
| Watch workers live (in pi) | `/workers` or `/workers <name>` |
| Watch from another terminal | `scripts/watch.sh [name]` |
| Status table and column legend (in pi) | `/workers-legend` |
| Message / steer a worker | `/worker-send <name> <message>` or viewer `m` |
| Abort a worker's task | `/worker-stop <name>` or viewer `a` |
| Kill one / all workers | `/worker-stop <name> kill` / `/worker-stop all kill` |
| Logs of the latest run | `ls ~/.pi/agent/multi-agent/latest/` |
| List live worker processes | `ps aux \| grep -E -- '[-]-name worker:'` |
| Smoke-test the worker layer | `node scripts/smoke-worker.ts` |
| Test: typing interrupts `worker_wait` | `node scripts/test-wait-interrupt.ts` (T7) |
| Test: manager does not wait; result auto-reported | `node scripts/test-auto-report.ts` (T8) |
| Test: interrupt in the interactive TUI | tmux recipe (T9) |
| Test: widget and viewer with many workers (no model calls) | `node scripts/test-ui-overflow.ts` (T10) |

## Prerequisites

| Component | Tested with | Notes |
|---|---|---|
| pi | 1.6.0 | `pi --version` |
| OS | macOS (Darwin 27.2) | Linux should work; Windows is untested |
| Node.js | v26.2.0 | Only needed to run `scripts/smoke-worker.ts` (requires Node with TypeScript type stripping, ≥ 22.18 or ≥ 23.6) |
| jq | 1.7+ | Optional, for the event-log recipes |
| tmux | 3.8 | Optional, for scripted interactive tests |

A model must be configured in pi. Workers use the manager's model unless told otherwise. Check with
`pi --list-models`.

## Install, upgrade, uninstall

**Try without installing** (nothing is written to settings):

```bash
pi -e /path/to/pi-multi-agent/extensions/multi-agent/index.ts
```

**Install globally** (`~/.pi/agent/settings.json`) or **per project** (`.pi/settings.json`; requires project trust):

```bash
pi install /path/to/pi-multi-agent
pi install -l /path/to/pi-multi-agent
pi list                                   # verify it is listed
```

Running pi sessions pick it up after `/reload`. Reloading stops any running workers.

**Verify** in a new pi session. Type `/work` and the completions should show `/workers`, `/worker-send`,
`/worker-stop` and `/workers-clear`. Or run [T1](#t1-extension-loads).

**Upgrade the extension:** pull or edit the repo, then `/reload` in running sessions (stops their workers).
A local path install is used in place, so there is nothing to reinstall.

**After upgrading pi:** run [T1](#t1-extension-loads), [T2](#t2-worker-rpc-layer) and [T4](#t4-manager-end-to-end).
The extension depends on pi's RPC protocol and extension API; the list is in
[architecture.md](docs/architecture.md#pi-apis-this-depends-on).

**Uninstall:**

```bash
pi remove /path/to/pi-multi-agent      # add -l if installed per project
```

Logs and worker sessions are not removed; see [Maintenance](#maintenance).

## Smoke tests

Run these from the repo root. Each test notes its expected result and approximate cost (measured with
`claude-code/default`).

### T1. Extension loads

No model calls.

```bash
(printf '{"id":"1","type":"get_commands"}\n'; sleep 5) \
  | pi --mode rpc --no-session -e ./extensions/multi-agent/index.ts 2>/dev/null \
  | jq -c 'select(.type=="response") | [.data.commands[] | select(.source=="extension") | .name]'
```

**Expected:** the list starts with `"workers","worker-send","worker-stop","workers-legend","workers-clear"`. The rest come from your
other extensions. If it fails, run the same command without `2>/dev/null` and read the extension error.

### T2. Worker RPC layer

About $0.02, 5 s.

```bash
node scripts/smoke-worker.ts            # optional arg: model, e.g. node scripts/smoke-worker.ts claude-code/claude-haiku-5-5
```

**Expected:** status lines `idle → running … bash $ echo hello-from-worker … done`, then `result: 'pong'`,
`toolCalls: 1`, `stopped: status=stopped alive=false`, the log printed with `▶ bash` / `✓ … hello-from-worker` / `│ pong`,
and `stderr: ""`.

### T3. Thinking capture

About $0.02, 10 s. Model-dependent.

```bash
SMOKE_THINKING=xhigh \
SMOKE_TASK='Without tools: how many prime numbers are strictly between 1000 and 1100? Reason carefully, then give the count and the list.' \
node scripts/smoke-worker.ts
```

**Expected:** `transcript kinds: task thinking text`, and `┊` lines in the printed log. If you get `task text`, the
model returned no thinking: see [No thinking shown](#no-thinking-shown).

### T4. Manager end-to-end

About $0.10, 15 s. Two parallel workers plus `worker_wait`:

```bash
pi -p --no-session --thinking low -e ./extensions/multi-agent/index.ts \
  "Use worker_spawn to start two workers in parallel (thinking 'low', tools 'bash,read'): worker 'counter' must count the .ts files under the extensions/ directory with bash and reply with just the number; worker 'reader' must read package.json and reply with just the package name. Then call worker_wait once for both, and finally answer with exactly two lines: 'counter: <result>' and 'reader: <result>'."
```

**Expected:** `counter: 4` and `reader: pi-multi-agent`, and two `.log` files in `~/.pi/agent/multi-agent/latest/`
ending in `stopped: pi exited (code 0, …)`.

### T5. No orphan processes

Run after T2 or T4, or after quitting any manager:

```bash
ps aux | grep -E -c -- '[-]-name worker:'      # expected: 0
```

### T6. Interactive (manual)

1. `pi -e ./extensions/multi-agent/index.ts`
2. Ask: *"Spawn two workers (thinking high): 'alpha' lists the files in extensions/multi-agent and describes each;
   'beta' works out without tools how many primes lie between 2000 and 2100. Don't wait; reply 'ok'."*
3. **Widget:** two rows appear, with live 💭 thinking or ⟳ tool activity and elapsed time.
4. **Auto-notify:** `⚑ worker … done` messages arrive, and the manager responds to them on its own.
5. `/workers beta`: `Home` shows the task and `┊` thinking; `→` switches to alpha and shows `▶` tool calls with `✓`
   results.
6. Press `m`, type `Reply with just the word: ack`, Enter. The viewer reopens and shows `✉ …` and `│ ack`.
7. `Esc` closes the viewer, and the widget is back. Quit pi, then run T5.

### T7. Typing interrupts `worker_wait`

About $0.01, 20 s. Runs a manager over RPC with the installed extension.

```bash
node scripts/test-wait-interrupt.ts     # optional arg: model, default claude-code/claude-haiku-5-5
TEST_MODE=follow_up node scripts/test-wait-interrupt.ts   # the Alt+Enter path
```

The manager spawns a worker that sleeps 60 s, then calls `worker_wait`. After 3 s the test sends a steer message.

**Expected:** `outcome=interrupted latency_ms=<1000 workers_still_running=1`, then `PASS`.

### T8. No wait after spawn; result auto-reported

About $0.01, 25 s.

```bash
node scripts/test-auto-report.ts
```

**Expected:** `worker_wait=0 toasts=1 agent_end=2`, the manager's summary of the result, then `PASS`.
The `worker_wait` count also includes `wait: true` on `worker_spawn` and `worker_send`.

### T9. Interactive TUI interrupt (tmux)

About $0.01, 90 s.

```bash
tmux new-session -d -s tuitest -x 160 -y 50 -c "$PWD" "pi --no-session --model claude-code/claude-haiku-5-5 --thinking off"
tmux send-keys -t tuitest -l 'I ask you to wait. 1) worker_spawn name "s3", tools "bash", task "Run: sleep 20. Then reply done." 2) worker_wait names ["s3"] timeoutSeconds 120.'
tmux send-keys -t tuitest Enter
# when the pane shows "Waiting for 1/1":
tmux send-keys -t tuitest -l 'Master here: say OK.'; tmux send-keys -t tuitest M-Enter   # or Enter for steer
tmux capture-pane -p -S -300 -t tuitest | rg -n 'Wait stopped|OK|Worker s3 done|⚑ worker s3'
tmux kill-session -t tuitest
```

**Expected:** `Wait stopped because the user sent a message` within 1 s, the manager answers `OK`, then the toast
`Worker s3 done` (no `Warning:` prefix), and then `⚑ worker s3 done`.

### T10. Many workers: widget overflow and viewer tabs

Free, 1 s. No model calls: the workers are fakes rendered with pi's real TUI functions.

```bash
node scripts/test-ui-overflow.ts        # add -v to print the rendered widget and tab bars
```

**Expected:** 18 `PASS` lines and `all passed`. They cover the widget row order, the `… N more (…)` line,
`PI_MULTI_AGENT_WIDGET_ROWS`, widget clicks, and the viewer tab window at widths 120, 80 and 60 (current tab and
counter always visible, markers only where tabs are hidden, marker clicks). The script finds pi's packages through the
`pi` on `PATH`; if that fails, set `PI_NODE_MODULES` to the `node_modules` directory that contains
`@earendil-works/pi-tui`.

To see it live (about $0.03 with haiku), start pi with `PI_MULTI_AGENT_MAX_WORKERS=12` and ask for 10 workers that
each run `sleep 90`. The widget shows 8 rows and `… 2 more (2 running)`; `/workers` then shows `‹ N` / `N ›` markers.

## Operating a session

**Start.** Open pi with the extension, and ask the manager to delegate. Tips for good worker tasks are in the
[User Guide](docs/user-guide.md#writing-good-worker-tasks).

**Monitor.**
- Widget: running count, per-worker status, cost, elapsed time, latest thinking or activity.
- `/workers`: full live transcript of one worker.
- From a second terminal: `scripts/watch.sh` (tails all `.log` files of the latest run).
- Ask the manager: *"what is each worker doing?"*. It calls `worker_status`.

**Intervene.**

| Situation | Action |
|---|---|
| Worker going in the wrong direction | Viewer `m` (or `/worker-send <name> …`) with a correction. It is delivered after the worker's current step |
| Worker stuck on a long tool call | Viewer `a` to abort the task. The worker stays usable; then send new instructions |
| Worker misbehaving or no longer needed | Viewer `k`, or `/worker-stop <name> kill` |
| Manager blocked in a long `worker_wait` | Type your message. The wait stops within 1 s, and the manager reads it. `Esc` also works. The workers keep running in both cases |
| Too many results flooding the manager | Ask it to use `notify: false` and collect with `worker_wait` |

**End.** Quitting the manager (or `/new`, `/resume`, `/reload`) stops all workers. Transcripts remain in
`~/.pi/agent/multi-agent/runs/<run>/` and in the worker session files.

## Troubleshooting

First look at the worker's files: `~/.pi/agent/multi-agent/latest/<name>.log` (what happened) and
`<name>.stderr.log` (why the process failed).

| Symptom | Likely cause | Fix |
|---|---|---|
| `worker_spawn` error: `failed to start: … get_state timed out` | pi took more than 120 s to start (package install or update, slow network, project trust prompt) | Check `<name>.stderr.log`. Run `pi --mode rpc --no-session` by hand in the same cwd and look for prompts or errors. Retry |
| `failed to start: pi exited (code 1 …)` | Bad worker args: unknown `--model`, invalid `--tools`, bad `PI_MULTI_AGENT_WORKER_ARGS` | The error includes the stderr tail. Check `pi --list-models` and the arguments in the `cmd:` line of `<name>.log` |
| `Worker "x" already exists` | Name in use by a live worker | Use `worker_send`, choose another name, or kill it first |
| `Too many live workers (8/8)` | Limit reached; idle workers count too | Kill idle workers (`/worker-stop <name> kill`) or set `PI_MULTI_AGENT_MAX_WORKERS` before starting pi |
| Worker shows `waiting for model` for a long time | Provider latency, rate limits, or a very large context | Look in `<name>.log` for `• retry …` lines. Steer with a narrower task, or abort and respawn on another model |
| Worker shows `waiting for you: …` | An extension inside the worker opened a dialog | Answer the `[worker <name>] …` dialog in the manager UI. In print mode dialogs are auto-cancelled |
| <a id="no-thinking-shown"></a>No thinking shown | The model has no thinking, the level is `off`, or the model chose not to think (adaptive) | Check with `jq -c 'select(.type=="message_end" and .message.role=="assistant") \| [.message.content[].type]' <name>.events.jsonl`. Use a thinking-capable model and level (`thinking: "high"`). See [observability.md](docs/observability.md#thinking) |
| Widget not visible | No workers yet, the viewer is open, or the manager runs without a UI (print mode) | Spawn a worker. Close the viewer. In RPC hosts the widget is plain text |
| Manager keeps getting `⚑ worker … done` messages | Auto-notify (default) for workers nobody waits on, including tasks you sent with `m`/`/worker-send` | Ask the manager to use `worker_wait` or `notify: false` |
| A result says `[result truncated …]` | Over the 40 KB tool-result budget (shared across workers) | The full text is in `<name>.result.md`. Ask workers for more concise output |
| Worker status `crashed` | Process died (OOM, killed, pi bug) | Read the `errorMessage` (in `worker_status <name>`) and `<name>.stderr.log`. Respawn with the same name |
| Two workers overwrote each other's edits | No locking between workers | `git diff` / `git checkout -p` to recover. Give workers disjoint files |
| `/workers` shows only a notification | Manager is not in TUI mode (RPC host) | Use the widget, `worker_status`, logs, or `scripts/watch.sh` |
| `scripts/watch.sh` misses a worker | Its glob is expanded at start | Re-run it, or `scripts/watch.sh <name>` |
| Extension missing in a project after `pi install -l` | Project not trusted | Trust the project when pi asks, or use a global install |
| Session list cluttered with `worker:*` sessions | Workers persist sessions by default | `export PI_MULTI_AGENT_WORKER_ARGS="--no-session"` (or `--session-dir <dir>`) before starting pi. Cleanup: [Maintenance](#maintenance) |

## Emergency stop

From inside the manager:

```
/worker-stop all kill
```

From a shell, for example when the manager is hung:

```bash
ps aux | grep -E -- '[-]-name worker:'                 # inspect first: this matches workers of ALL managers
pkill -TERM -f -- '--name worker:'                      # orderly shutdown; send it twice to exit immediately
pkill -KILL -f -- '--name worker:'                      # last resort
```

## Maintenance

**Run logs** accumulate in `~/.pi/agent/multi-agent/runs/`:

```bash
du -sh ~/.pi/agent/multi-agent/runs
find ~/.pi/agent/multi-agent/runs -mindepth 1 -maxdepth 1 -type d -mtime +7 -print                # list runs older than 7 days
find ~/.pi/agent/multi-agent/runs -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +     # delete them
```

**Worker session files** are named `worker:<name>` in their `session_info` entry. To list them (this skips
ordinary sessions, even ones that mention workers):

```bash
for f in ~/.pi/agent/sessions/*/*.jsonl; do
  head -n 5 "$f" | jq -e 'select(.type=="session_info" and ((.name // "") | startswith("worker:")))' >/dev/null 2>&1 && echo "$f"
done
```

Review the list, then delete what you don't need (for example pipe it to `xargs rm` after checking). To stop
creating them, set `PI_MULTI_AGENT_WORKER_ARGS="--no-session"`.

## Collecting a bug report

1. `pi --version`, OS, and the model(s) used.
2. The run directory: `~/.pi/agent/multi-agent/runs/<run>/` (`.log`, `.events.jsonl`, `.stderr.log`).
3. The worker's session file (path at the top of `<name>.log`).
4. What the manager was asked, and what `worker_status <name>` returned.
5. Whether [T1–T5](#smoke-tests) pass.

These files contain your prompts and code. Review them before sharing.
