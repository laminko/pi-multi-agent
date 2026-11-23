#!/bin/sh
# Follow worker logs (thinking, output, tool calls) from another terminal.
#
#   scripts/watch.sh            # all workers of the latest run
#   scripts/watch.sh scout      # one worker
#   scripts/watch.sh -l         # list runs
#
# Logs live in ${PI_MULTI_AGENT_DIR:-~/.pi/agent/multi-agent}/runs/<run>/,
# and "latest" points at the newest run.

ROOT="${PI_MULTI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/multi-agent}"
RUN="$ROOT/latest"

if [ "$1" = "-l" ]; then
  ls -1t "$ROOT/runs" 2>/dev/null || echo "no runs yet in $ROOT/runs"
  exit 0
fi

if [ ! -e "$RUN" ]; then
  echo "No runs yet ($RUN missing). Spawn a worker first." >&2
  exit 1
fi

if [ -n "$1" ]; then
  exec tail -n +1 -F "$RUN/$1.log"
fi

# Note: the glob is expanded once; re-run to pick up workers spawned later.
exec tail -n +1 -F "$RUN"/*.log
