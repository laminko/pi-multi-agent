# Runbook

Operational procedures for pi-multi-agent: install, verify, operate, troubleshoot, maintain.
Commands assume pi's agent dir is `~/.pi/agent`. The package source is `git:github.com/laminko/pi-multi-agent`;
commands that run `scripts/…` or `./extensions/…` assume a clone of the repository as the current directory.

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
| Try for one session | `pi -e git:github.com/laminko/pi-multi-agent` |
| Install for all sessions | `pi install git:github.com/laminko/pi-multi-agent` |
| Update / uninstall | `pi update git:github.com/laminko/pi-multi-agent` / `pi remove git:github.com/laminko/pi-multi-agent` |
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
| Test: result blocks parse and render (no model calls) | `node scripts/test-render-report.ts` (T11) |
| Test: resume records and session repair (no model calls) | `node scripts/test-resume.ts` (T12) |
| Test: health checks, with fake worker processes (no model calls) | `node scripts/test-health.ts` (T13) |
| Test: the manager follows up on a stuck worker | `node scripts/test-health-live.ts` (T14) |
| Test: idle cleanup, with fake worker processes (no model calls) | `node scripts/test-idle.ts` (T15) |
| Test: idle cleanup with a real model | `node scripts/test-idle-live.ts <project>` (T16) |
| Idle cleanup setting (set before starting pi) | `PI_MULTI_AGENT_IDLE_MINUTES=10` (min; `0` = off) |
| Health check settings (set before starting pi) | `PI_MULTI_AGENT_HEALTH_INTERVAL=10` (s; `0` = off), `PI_MULTI_AGENT_STALL_SECONDS=180` |
| **pi quit while workers ran** | `pi -c`, then `/workers-resume` ([details](#recovering-after-pi-quits)) |

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

**Try without installing** (nothing is written to settings; pi caches the clone in `~/.pi/agent/tmp/extensions/`):

```bash
pi -e git:github.com/laminko/pi-multi-agent
```

**Install globally** (`~/.pi/agent/settings.json`) or **per project** (`.pi/settings.json`; requires project trust):

```bash
pi install git:github.com/laminko/pi-multi-agent
pi install -l git:github.com/laminko/pi-multi-agent
pi list                                   # verify it is listed
```

To pin a version, append a tag or commit: `git:github.com/laminko/pi-multi-agent@<ref>`. Running pi sessions pick
the extension up after `/reload`. Reloading stops any running workers; busy ones can be resumed with
`/workers-resume`.

**From a clone** (for development):

```bash
git clone https://github.com/laminko/pi-multi-agent.git && cd pi-multi-agent
pi -e ./extensions/multi-agent/index.ts   # this session only; or `pi install .` to use the clone in place
```

Load only one copy. With the package installed and a clone loaded through `-e`, both register the same tools and
one of them fails to load (see [Troubleshooting](#troubleshooting)).

**Verify** in a new pi session. Type `/work` and the completions should show `/workers`, `/workers-legend`,
`/workers-resume`, `/worker-send`, `/worker-stop` and `/workers-clear`. Or run [T1](#t1-extension-loads).

**Upgrade the extension:**

```bash
pi update git:github.com/laminko/pi-multi-agent   # or `pi update --extensions` for all packages
```

Then `/reload` running sessions. A pinned `@<ref>` does not move: change the ref to upgrade. A clone installed by
path is used in place: `git pull`, then `/reload`.

**After upgrading pi:** run [T1](#t1-extension-loads), [T2](#t2-worker-rpc-layer) and [T4](#t4-manager-end-to-end).
The extension depends on pi's RPC protocol and extension API; the list is in
[architecture.md](docs/architecture.md#pi-apis-this-depends-on).

**Uninstall:**

```bash
pi remove git:github.com/laminko/pi-multi-agent      # add -l if installed per project
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

**Expected:** the list starts with `"workers","worker-send","worker-stop","workers-legend","workers-resume","workers-clear"`.
The rest come from your other extensions. If it fails, run the same command without `2>/dev/null` and read the
extension error. If pi-multi-agent is also installed, the two copies conflict (`Tool "worker_spawn" conflicts`): add
`--no-extensions` before `-e` to load only this checkout.

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

**Expected:** 21 `PASS` lines and `all passed`. They cover the widget row order, the `… N more (…)` line,
`PI_MULTI_AGENT_WIDGET_ROWS`, widget clicks, and the viewer tab window at widths 120, 80 and 60 (current tab and
counter always visible, markers only where tabs are hidden, marker clicks). The script finds pi's packages through the
`pi` on `PATH`; if that fails, set `PI_NODE_MODULES` to the `node_modules` directory that contains
`@earendil-works/pi-tui`.

To see it live (about $0.03 with haiku), start pi with `PI_MULTI_AGENT_MAX_WORKERS=12` and ask for 10 workers that
each run `sleep 90`. The widget shows 8 rows and `… 2 more (2 running)`; `/workers` then shows `‹ N` / `N ›` markers.

### T11. Result rendering

Free, 1 s. No model calls.

```bash
node scripts/test-render-report.ts      # add -v to print the rendered views
```

**Expected:** 24 `PASS` lines and `all passed`. The parse checks feed the real producer (`formatResultBlock`) back
into the parser: plain, truncated, crashed with a multi-line error, running, a result that contains `</result>` and
`</worker>`, `worker_wait` and `worker_status` output, and a malformed block. The render checks confirm: no tags, a
drawn table, Markdown in the result, the collapsed hint, the legend's alignment, and every line within the width.

To see it live (under $0.01 with haiku): ask the manager to spawn one worker whose task is to reply with a Markdown
report, and not to wait. The `⚑ worker … done` message shows a drawn table and the rendered report; `ctrl+o` expands it.

### T12. Resume after quit

Free, 1 s. No model calls; the session files are real (pi's `SessionManager`) in a temp directory.

```bash
node scripts/test-resume.ts
```

**Expected:** 10 `PASS` lines and `all passed`: record merging (only workers busy at their last record are
interrupted; later records keep earlier fields; the latest task wins), session repair (an unanswered tool call gets an
error result, a second run changes nothing, only the unanswered one of two parallel calls is fixed, clean sessions are
left alone), and the old-process check.

**Live (about $0.01 with haiku, 2 min):** in an empty directory, start the manager and ask for one worker whose task
is `Step 1: echo one > step1.txt. Step 2: sleep 25. Step 3: echo three > step3.txt. Then reply finished-all-steps`.
When its log shows `▶ bash $ sleep 25`, close the terminal (or `tmux kill-server`). Then:

1. `pi -c` opens the **manager** (not a worker) and shows `↯ 1 interrupted (/workers-resume)` in the widget.
2. `/workers-resume` → `resumer: resumed in its own session`.
3. The worker checks the files, re-runs only the sleep and step 3, and the `⚑ worker … done` result is
   `finished-all-steps`. `step3.txt` exists. The manager's reply does not claim that the worker is not running.
4. Repeat the quit, then ask in plain words (`My workers got interrupted. Please continue them.`): the manager calls
   `worker_resume`, and a single `worker_wait` returns the result.

### T13. Health checks

Free, 15 s. No model calls: the script also plays the worker (`--mode rpc`), so the extension runs real child
processes that go quiet, freeze, or loop on purpose.

```bash
node scripts/test-health.ts
```

**Expected:** 33 `PASS` lines and `all passed`: settings from the environment (defaults, values, `0`/`off`, junk);
verdicts (ok, quiet, unresponsive before quiet, a dialog is `waiting`, loop, "no run in progress"); alert timing (3,
6, then not before 12 minutes; recovery keeps the count); the `⚠` warning in the table and widget, and that it goes
with the next event; the alert text. Then the extension, loaded with a mocked pi API, a 1 s interval and a 2 s stall:
a quiet, a frozen and a looping worker each produce one alert message (`followUp`, `triggerTurn`) and a toast;
`worker_status` shows the warnings and the settings; heartbeat replies stay out of `<name>.events.jsonl`; a
`wait: true` spawn returns `stalled` within a few seconds and no separate message; the alert view renders; the
warning goes after an abort; no process is left after shutdown.

### T14. The manager follows up on a stuck worker

About $0.02 with haiku, 30 s.

```bash
TEST_EXTENSIONS=~/.pi/agent/git/github.com/earendil-works/pi-claude-code node scripts/test-health-live.ts
```

The manager loads this checkout's extension and nothing else that is installed (`--no-extensions`, so an installed
pi-multi-agent cannot conflict); add the provider package of your model to `TEST_EXTENSIONS` (`:`-separated), or pass
a model that needs none as the first argument. It checks every 2 s and calls a worker quiet after 15 s; the worker
runs `sleep 120`.

**Expected:** about 15 s after the worker starts its `sleep`, a toast `Worker sleeper may be stuck (quiet): no output
for 16s; now: bash $ sleep 120; its process still answers status checks` and the same alert to the manager; the
manager starts a turn by itself, calls `worker_status` (or `worker_stop` / `worker_send`) and reports what it found;
`PASS`. A model that refuses the pointless `sleep` or writes its tool call as text (seen with
`claude-local/claude-haiku-4-5`) finishes in seconds and fails the test; use another model.

### T15. Idle cleanup

Free, 10 s. No model calls: the script also plays the worker, which answers every task at once.

```bash
node scripts/test-idle.ts
```

**Expected:** 21 `PASS` lines and `all passed`: settings (default 10 min / 30 s tick, `0`/`off`, fractions, junk);
the reap rule (idle time, busy, waited on, dialog, never had a task, off). Then the extension with a 2 s idle time: an
idle worker's process stops while a reused one stays alive; the stopped one stays listed with the hint and the
setting; an info toast and no manager message; `worker_send` revives it on its own session file with counters and
history; a killed worker is not revived; no process is left after shutdown.

### T16. Idle cleanup, live

About $0.01 with haiku, 50 s. Run it in a project that has `tests/test_todo.py` (e.g. the `todo-sqlite` scratch project).

```bash
cd ~/LLM_playground/todo-sqlite
TEST_EXTENSIONS=~/.pi/agent/git/github.com/earendil-works/pi-claude-code node ~/LLM_playground/pi-multi-agent/scripts/test-idle-live.ts .
```

The manager runs with `PI_MULTI_AGENT_IDLE_MINUTES=0.5`. It spawns a read-only worker `counter` that gets a random
code word and counts the test functions. The worker then stays unused.

**Expected:** the result is auto-reported; about 30 s later a toast `Worker counter stopped after 32s idle` and the
first pid is gone; the manager is asked to `worker_send` the same worker; the reply starts `It had been stopped for
being idle; restarted on its own session…`; a new pid runs; the worker answers with the code word without reading
files; `PASS`, `0 orphans`.

## Operating a session

**Start.** Open pi with the extension, and ask the manager to delegate. Tips for good worker tasks are in the
[User Guide](docs/user-guide.md#writing-good-worker-tasks).

**Monitor.**
- Widget: running count, per-worker status, cost, elapsed time, latest thinking or activity.
- `/workers`: full live transcript of one worker.
- From a second terminal: `scripts/watch.sh` (tails all `.log` files of the latest run).
- Ask the manager: *"what is each worker doing?"*. It calls `worker_status`.
- Nothing, for stuck workers: the manager's health checks flag them (`⚠` in the widget, a toast) and the manager
  follows up by itself. See [Observability](docs/observability.md#stuck-workers-health-checks).

**Intervene.**

| Situation | Action |
|---|---|
| Worker going in the wrong direction | Viewer `m` (or `/worker-send <name> …`) with a correction. It is delivered after the worker's current step |
| Worker stuck on a long tool call | Viewer `a` to abort the task. The worker stays usable; then send new instructions |
| Worker misbehaving or no longer needed | Viewer `k`, or `/worker-stop <name> kill` |
| Manager blocked in a long `worker_wait` | Type your message. The wait stops within 1 s, and the manager reads it. `Esc` also works. The workers keep running in both cases |
| Too many results flooding the manager | Ask it to use `notify: false` and collect with `worker_wait` |

**End.** Quitting the manager (or `/new`, `/resume`, `/reload`) stops all workers. Transcripts remain in
`~/.pi/agent/multi-agent/runs/<run>/` and in the worker session files. Workers that were busy can be resumed later:
see the next section.

## Recovering after pi quits

When pi quits while workers run (Ctrl+C, Ctrl+D, a closed terminal, `/reload`, or a crash), the worker processes
stop. Their work is resumable, as long as the manager session was saved (not `--no-session`).

1. **Reopen the manager session.** `pi -c` in the same directory (add `-e …/index.ts` if the extension is not
   installed), or `pi -r` and pick it. With workers from before v0.7.0, `pi -c` may open a worker session (named
   `worker:<name>`) instead; then use `pi -r` and pick the session that is not named `worker:…`.
2. **Check what was interrupted.** A toast lists the workers; the widget shows them as `↯ interrupted`;
   `/workers <name>` shows the task they were working on and the path of the interrupted run's log.
3. **Check the files.** Interrupted workers may have left half-done edits: `git status` / `git diff`.
4. **Resume.** `/workers-resume` (all) or `/workers-resume <name>`, or ask the manager to continue them. Each
   worker continues in its own session, checks what is done, and finishes; the result arrives as `⚑ worker … done`.
5. **Or drop them.** `/worker-stop <name> kill` or `/workers-clear` dismisses interrupted workers; they are not
   offered again.

Resume results and what they mean:

| Line | Meaning |
|---|---|
| `resumed in its own session` | Normal case |
| `…; N unfinished tool call(s) marked as not run` | pi quit while the model was making a tool call; the session was repaired first |
| `had no session file, so it restarted its task` | The worker ran with `--no-session` (or the file is gone); it starts over with its recorded task and a note to check what is done |
| `its old process (pid N) still runs …` | The manager died hard and the old worker is still finishing. Wait, or `kill N`, then resume again |
| `not interrupted (…), nothing to resume` | The worker finished, was dismissed, or was already resumed |

## Troubleshooting

First look at the worker's files: `~/.pi/agent/multi-agent/latest/<name>.log` (what happened) and
`<name>.stderr.log` (why the process failed).

| Symptom | Likely cause | Fix |
|---|---|---|
| `worker_spawn` error: `failed to start: … get_state timed out` | pi took more than 120 s to start (package install or update, slow network, project trust prompt) | Check `<name>.stderr.log`. Run `pi --mode rpc --no-session` by hand in the same cwd and look for prompts or errors. Retry |
| `failed to start: pi exited (code 1 …)` | Bad worker args: unknown `--model`, invalid `--tools`, bad `PI_MULTI_AGENT_WORKER_ARGS` | The error includes the stderr tail. Check `pi --list-models` and the arguments in the `cmd:` line of `<name>.log` |
| `Worker "x" already exists` | Name in use by a live worker | Use `worker_send`, choose another name, or kill it first |
| `Failed to load extension … Tool "worker_spawn" conflicts with …` | The extension is loaded twice: an installed package plus `-e`, or two installs | Keep one copy: check `pi list`, then `pi remove` the extra one, or drop the `-e` |
| `Too many live workers (8/8)` | Limit reached; idle workers count too | Kill idle workers (`/worker-stop <name> kill`) or set `PI_MULTI_AGENT_MAX_WORKERS` before starting pi |
| Worker shows `waiting for model` for a long time | Provider latency, rate limits, or a very large context | Look in `<name>.log` for `• retry …` lines. Steer with a narrower task, or abort and respawn on another model |
| `⚠ quiet …` / "may be stuck" alerts for workers that are fine | Long silent steps (builds, tests, `sleep`) or a model that thinks without streaming | The manager normally leaves them running. Raise `PI_MULTI_AGENT_STALL_SECONDS` (e.g. `600`) before starting pi |
| Too many health alerts in the manager's conversation | Many workers in long silent steps | Raise `PI_MULTI_AGENT_STALL_SECONDS`, spawn with `notify: false` (alerts then show only in toasts and `worker_status`), or set `PI_MULTI_AGENT_HEALTH_INTERVAL=0` to turn checks off |
| `⚠ not answering` | The worker's pi process does not answer status checks: blocked or hung | Kill it (`/worker-stop <name> kill`; the manager usually does this itself) and respawn. Its `<name>.log` and session file show how far it got |
| A stuck worker is never flagged | Health checks off (`PI_MULTI_AGENT_HEALTH_INTERVAL=0`), or it waits for your answer to a dialog (never flagged) | `worker_status` without a name prints the `health checks:` settings line; answer the `[worker <name>]` dialog |
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
| Session list cluttered with `worker:*` sessions | Workers from before v0.7.0 stored sessions in the project's list | New workers use `~/.pi/agent/multi-agent/sessions/`. Remove the old ones: [Maintenance](#maintenance) |
| `pi -c` opened a `worker:<name>` session | Worker sessions from before v0.7.0 are in the project's list and can be the newest | Quit it, run `pi -r` and pick the manager. See [Recovering after pi quits](#recovering-after-pi-quits) |
| A resumed worker fails with `tool_use ids were found without tool_result blocks` | Its session was not repaired (for example resumed by hand with `pi --session`) | Resume it with `/workers-resume`, which repairs the session first |
| No `↯ interrupted` workers after reopening, although workers were running | The manager ran with `--no-session`, or a different session was opened, or the workers had already finished | Open the right manager session (`pi -r`). Without a saved manager session there is nothing to restore; respawn the tasks |

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

**Worker session files.** Since v0.7.0, new ones are in `~/.pi/agent/multi-agent/sessions/`
(`PI_MULTI_AGENT_WORKER_SESSION_DIR`). Keep the sessions of interrupted workers until you have resumed or dismissed
them: resume needs them.

```bash
du -sh ~/.pi/agent/multi-agent/sessions
find ~/.pi/agent/multi-agent/sessions -name '*.jsonl' -mtime +7 -print     # older than 7 days; add -delete to remove
```

Worker sessions from before v0.7.0 are in pi's normal session directories, named `worker:<name>` in their
`session_info` entry. To list them (this skips ordinary sessions, even ones that mention workers):

```bash
for f in ~/.pi/agent/sessions/*/*.jsonl; do
  head -n 5 "$f" | jq -e 'select(.type=="session_info" and ((.name // "") | startswith("worker:")))' >/dev/null 2>&1 && echo "$f"
done
```

Review the list, then delete what you don't need (for example pipe it to `xargs rm` after checking). To stop
creating worker sessions at all, set `PI_MULTI_AGENT_WORKER_ARGS="--no-session"`; resume then restarts a worker's
task instead of continuing it.

## Collecting a bug report

1. `pi --version`, OS, and the model(s) used.
2. The run directory: `~/.pi/agent/multi-agent/runs/<run>/` (`.log`, `.events.jsonl`, `.stderr.log`).
3. The worker's session file (path at the top of `<name>.log`).
4. What the manager was asked, and what `worker_status <name>` returned.
5. Whether [T1–T5](#smoke-tests) pass.

These files contain your prompts and code. Review them before sharing.
