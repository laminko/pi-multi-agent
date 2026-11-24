# pi-multi-agent

Let your [pi](https://github.com/earendil-works/pi) hand work to other pi agents that run in parallel, and watch
them think while they work.

```mermaid
sequenceDiagram
    actor You
    participant M as Your pi (manager)
    participant W as Workers
    You->>M: a task with independent parts
    M->>W: one self-contained task per worker
    Note over W: Each worker is its own pi process<br/>and never sees your conversation.
    M-->>You: keeps talking with you
    W-->>M: results, as each one finishes
    M-->>You: reports the results
```

## Install

```bash
pi install git:github.com/laminko/pi-multi-agent
```

Or try it once without installing: `pi -e git:github.com/laminko/pi-multi-agent`. You need pi (tested with 1.6.0)
and a working model.

## Use

Ask pi in plain language:

> Spawn two read-only workers in parallel (tools: read, grep, find, ls). One summarizes what this project does in
> five bullets; the other lists every TODO and FIXME comment with file and line.

pi starts the workers and keeps talking with you. Each result appears as a `⚑ worker … done` message when it is
ready.

## Watch

The widget above the editor shows every worker, with its latest thinking (💭):

```
 St  Worker    Turns  Tools  Ctx  ↑In  ↓Out   Cost  Time  Now
 ●   reviewer      3      2  15k    4  1.4k  $0.14   25s  💭 …I'm also flagging that the `__main__` module lacks a guard…
 ✓   tests         4      3  12k   10  6.1k  $0.17   48s  → I wrote `tests/test_todo.py`. It has 39 tests…
```

Type `/workers` for a live view of one worker: its thinking, output and tool calls.

## If pi quits

Reopen with `pi -c` and type `/workers-resume`. Interrupted workers continue where they stopped.

## Learn more

- [User guide](docs/user-guide.md): prompting, stepping in, cost, limits
- [Observability](docs/observability.md): everything about watching workers
- [Reference](docs/reference.md): every tool, command and setting
- [Runbook](RUNBOOK.md): install details, troubleshooting, tests
- [Status](STATUS.md): what is verified, known issues

## License

[MIT](LICENSE)
