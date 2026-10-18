# pi-monitor

Monitor tool for [pi](https://github.com/earendil-works/pi), modeled on Claude Code's Monitor tool.

The agent starts a watch on a **shell command** (each stdout line is an event; exit ends the watch) or a **WebSocket** (each text frame is an event; close ends the watch). The tool returns immediately with a `taskId`; events are delivered later as messages that trigger a turn when the agent is idle — no polling, no sleeping.

## Tools

| Tool | Purpose |
|---|---|
| `monitor` | Start a watch (`command` XOR `ws`), with `description`, `timeout_ms` (default 10 min, max 1 h; one notice at expiry, re-arm to continue) or `persistent` (session lifetime) |
| `monitor_stop` | Kill a watch by `taskId` |
| `monitor_list` | List running watches |

`/monitors` lists running watches from the UI. Events are batched (≤2s) and capped per notification; overflow drops oldest lines and reports the drop count.

## Install

```
pi install /path/to/pi-monitor
```

or copy/symlink to `~/.pi/agent/extensions/`.

## Examples

- Tail a log: `monitor` with `command: "tail -f /var/log/app.log"`, `description: "app errors"`
- Wait for condition: `command: "until curl -sf localhost:3000/health; do sleep 2; done"`
- Watch CI: `command: "gh run watch && gh run view --log-failed"`
- Stream events: `ws: "wss://example.com/feed"`
