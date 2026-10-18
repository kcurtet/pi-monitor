/**
 * pi-monitor — Monitor tool for pi, modeled on Claude Code's Monitor tool.
 *
 * The agent starts a watch on a shell command (each stdout line is an event,
 * exit ends the watch) or a WebSocket (each text frame is an event, close ends
 * the watch). The tool returns immediately with a taskId; events are delivered
 * later as custom messages that trigger a turn when the agent is idle.
 *
 * Expiry / process exit send one final notification. `monitor_stop` kills a
 * watch, `monitor_list` lists running watches.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10 min
const MAX_TIMEOUT_MS = 60 * 60_000; // 1 h
const FLUSH_INTERVAL_MS = 2_000; // batch events, notify at most every 2s
const MAX_EVENTS_PER_NOTICE = 15;
const MAX_LINE_LENGTH = 500;
const MAX_PENDING = 200; // drop-oldest cap on buffered lines

interface Watch {
	id: string;
	description: string;
	kind: "bash" | "ws";
	startedAt: number;
	child?: ChildProcess;
	ws?: WebSocket;
	timeoutId?: ReturnType<typeof setTimeout>;
	pending: string[];
	eventCount: number;
	dropped: number;
	closed: boolean;
	flushTimer?: ReturnType<typeof setTimeout>;
}

let pi: ExtensionAPI;
let watches = new Map<string, Watch>();
let nextId = 1;

function taskId(): string {
	return `mon-${nextId++}`;
}

function truncateLine(line: string): string {
	return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "…" : line;
}

/** Format and deliver a notification to the agent (triggers a turn when idle). */
function notify(watch: Watch, lines: string[], isFinal: boolean, finalReason?: string): void {
	const header = `[Monitor ${watch.id} — ${watch.description}]`;
	let body: string;
	if (lines.length > MAX_EVENTS_PER_NOTICE) {
		const shown = lines.slice(0, MAX_EVENTS_PER_NOTICE).map(truncateLine).join("\n");
		body = `${shown}\n… (+${lines.length - MAX_EVENTS_PER_NOTICE} more, total ${watch.eventCount} events${watch.dropped ? `, ${watch.dropped} dropped (overflow)` : ""})`;
	} else {
		body = lines.map(truncateLine).join("\n");
	}
	let content: string;
	if (isFinal) {
		const reason = finalReason ?? "source ended";
		const ranFor = Math.round((Date.now() - watch.startedAt) / 1000);
		content = `${header} Watch ended (${reason}) after ${ranFor}s. Total events: ${watch.eventCount}${watch.dropped ? ` (${watch.dropped} dropped)` : ""}. Last events:\n${body || "(no events)"}`;
		if (finalReason === "timeout") {
			content += `\nDeadline expired. Re-arm the watch (start a new Monitor with the same command) if you still need it.`;
		}
	} else {
		content = `${header} ${lines.length} new event(s) (total ${watch.eventCount}):\n${body}\nKeep working on your current task; react to this only if the events require it.`;
	}
	pi.sendMessage(
		{
			customType: "monitor-event",
			content,
			display: true,
			details: { taskId: watch.id, description: watch.description, isFinal, reason: finalReason ?? null },
		},
		{ triggerTurn: true },
	);
}

function flush(watch: Watch): void {
	if (watch.flushTimer) {
		clearTimeout(watch.flushTimer);
		watch.flushTimer = undefined;
	}
	if (watch.closed || watch.pending.length === 0) return;
	const lines = watch.pending;
	watch.pending = [];
	notify(watch, lines, false);
	scheduleFlush(watch);
}

function scheduleFlush(watch: Watch): void {
	if (watch.closed || watch.flushTimer) return;
	watch.flushTimer = setTimeout(() => flush(watch), FLUSH_INTERVAL_MS);
	watch.flushTimer.unref?.();
}

function pushEvent(watch: Watch, line: string): void {
	watch.eventCount++;
	if (watch.pending.length >= MAX_PENDING) {
		watch.pending.shift();
		watch.dropped++;
	}
	watch.pending.push(line);
	scheduleFlush(watch);
}

function finalize(watch: Watch, reason: string): void {
	if (watch.closed) return;
	watch.closed = true;
	if (watch.timeoutId) clearTimeout(watch.timeoutId);
	if (watch.flushTimer) clearTimeout(watch.flushTimer);
	const lines = watch.pending;
	watch.pending = [];
	if (lines.length > 0 || watch.eventCount > 0 || reason !== "stopped") {
		notify(watch, lines, true, reason);
	}
	watches.delete(watch.id);
}

function killWatch(watch: Watch): void {
	watch.child?.kill("SIGTERM");
	setTimeout(() => watch.child?.kill("SIGKILL"), 5_000).unref?.();
	try {
		watch.ws?.close();
	} catch {
		// already closed
	}
}

function startBashWatch(command: string, description: string, timeoutMs: number, persistent: boolean): Watch {
	const watch: Watch = {
		id: taskId(),
		description,
		kind: "bash",
		startedAt: Date.now(),
		pending: [],
		eventCount: 0,
		dropped: 0,
		closed: false,
	};
	const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
	watch.child = child;
	let stdoutBuf = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdoutBuf += chunk;
		let idx: number;
		while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
			const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
			stdoutBuf = stdoutBuf.slice(idx + 1);
			if (line.trim()) pushEvent(watch, line);
		}
	});
	let stderrBuf = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderrBuf += chunk;
		let idx: number;
		while ((idx = stderrBuf.indexOf("\n")) >= 0) {
			const line = stderrBuf.slice(0, idx).replace(/\r$/, "");
			stderrBuf = stderrBuf.slice(idx + 1);
			if (line.trim()) pushEvent(watch, `[stderr] ${line}`);
		}
	});
	child.on("error", (err) => {
		pushEvent(watch, `[spawn error] ${err.message}`);
		finalize(watch, "error");
	});
	child.on("close", (code, signal) => {
		if (stdoutBuf.trim()) pushEvent(watch, stdoutBuf.trim());
		finalize(watch, code === 0 ? "exited cleanly" : `exited (${signal ?? `code ${code}`})`);
	});
	if (!persistent) {
		watch.timeoutId = setTimeout(() => {
			killWatch(watch);
			finalize(watch, "timeout");
		}, timeoutMs);
		watch.timeoutId.unref?.();
	}
	return watch;
}

function startWsWatch(url: string, description: string, timeoutMs: number, persistent: boolean): Watch {
	const watch: Watch = {
		id: taskId(),
		description,
		kind: "ws",
		startedAt: Date.now(),
		pending: [],
		eventCount: 0,
		dropped: 0,
		closed: false,
	};
	const ws = new WebSocket(url);
	watch.ws = ws;
	ws.addEventListener("message", (ev) => {
		const text = typeof ev.data === "string" ? ev.data : "[binary frame]";
		for (const line of text.split("\n")) {
			if (line.trim()) pushEvent(watch, line);
		}
	});
	ws.addEventListener("close", () => finalize(watch, "socket closed"));
	ws.addEventListener("error", () => pushEvent(watch, "[socket error]"));
	if (!persistent) {
		watch.timeoutId = setTimeout(() => {
			killWatch(watch);
			finalize(watch, "timeout");
		}, timeoutMs);
		watch.timeoutId.unref?.();
	}
	return watch;
}

const MonitorParams = Type.Object(
	{
		command: Type.Optional(
			Type.String({ description: "Shell command or script. Each stdout line is an event; exit ends the watch. Cannot be combined with ws." }),
		),
		ws: Type.Optional(
			Type.String({ description: "WebSocket URL (ws:// or wss://). Each text frame is an event; socket close ends the watch. Cannot be combined with command." }),
		),
		description: Type.String({ description: "Short human-readable description of what is being monitored (shown in notifications)." }),
		timeout_ms: Type.Optional(
			Type.Number({
				minimum: 1000,
				description: `Kill the monitor after this deadline in ms. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Ignored when persistent is true. You are notified at expiry and can re-arm.`,
			}),
		),
		persistent: Type.Optional(Type.Boolean({ description: "Run for the lifetime of the session (no timeout). Stop it with monitor_stop." })),
	},
	{ $id: "MonitorParams" },
);

const MonitorStopParams = Type.Object(
	{
		taskId: Type.String({ description: "ID of the monitor task to stop." }),
	},
	{ $id: "MonitorStopParams" },
);

export default function monitorExtension(api: ExtensionAPI) {
	pi = api;

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Stream events from a background process as live notifications. Provide a shell `command` (each stdout line is an event; exit ends the watch) or a `ws` WebSocket URL (each text frame is an event; close ends the watch) — exactly one of the two. " +
			"Use for: log tails (`tail -f`), watching a build/test run, polling until a condition (`until <check>; do sleep 2; done`), waiting for CI (`gh run watch`). " +
			"Returns immediately with a taskId; do NOT sleep or poll afterwards — you will be notified with the events, and they may arrive while you are waiting for the user. " +
			`Default deadline is ${DEFAULT_TIMEOUT_MS / 60000} minutes (extend with timeout_ms, max ${MAX_TIMEOUT_MS / 60000} minutes) or use persistent for session-length watches.`,
		promptSnippet: "watch a background command or WebSocket and get notified on each event",
		promptGuidelines: [
			"Do not sleep between commands that can run immediately — just run them.",
			"To wait for a condition, use monitor with an until-loop (e.g. `until <check>; do sleep 2; done`) instead of sleeping: you get a notification when the loop exits.",
			"For one-shot 'wait until done', prefer starting the command with monitor anyway and reacting to its exit notification.",
			"Do not re-check a monitor: notifications arrive by themselves.",
		],
		parameters: MonitorParams,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		execute: async (_id, params) => {
			const hasCmd = params.command !== undefined;
			const hasWs = params.ws !== undefined;
			if (hasCmd === hasWs) {
				throw new Error("Provide exactly one of `command` or `ws`.");
			}
			if (params.ws !== undefined && !/^wss?:\/\//i.test(params.ws)) {
				throw new Error("`ws` must be a ws:// or wss:// URL.");
			}
			const persistent = params.persistent === true;
			const timeoutMs = persistent ? 0 : Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const watch = params.command !== undefined
				? startBashWatch(params.command, params.description, timeoutMs, persistent)
				: startWsWatch(params.ws!, params.description, timeoutMs, persistent);
			watches.set(watch.id, watch);
			const expiry = persistent ? "persistent — runs until monitor_stop or session end" : `expires in ${Math.round(timeoutMs / 1000)}s unless the source ends first`;
			return {
				content: [{ type: "text", text:
					`Monitor started (task ${watch.id}, ${params.command !== undefined ? "command" : "websocket"}, ${expiry}). ` +
					"You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply." }],
				details: { taskId: watch.id, kind: watch.kind, timeoutMs, persistent, description: watch.description },
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Stop Monitor",
		description: "Stop a running monitor started with the monitor tool.",
		parameters: MonitorStopParams,
		annotations: { destructiveHint: false },
		execute: async (_id, params) => {
			const watch = watches.get(params.taskId);
			if (!watch) {
				return { content: [{ type: "text", text: `No running monitor with taskId ${params.taskId}. Use monitor_list to see running watches.` }], details: undefined };
			}
			killWatch(watch);
			finalize(watch, "stopped");
			return { content: `Monitor ${params.taskId} (${watch.description}) stopped. ${watch.eventCount} events total.`, details: { stopped: params.taskId } };
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "List Monitors",
		description: "List currently running monitors.",
		parameters: Type.Object({}, { $id: "MonitorListParams" }),
		annotations: { readOnlyHint: true },
		execute: async () => {
			if (watches.size === 0) {
				return { content: "No running monitors.", details: { watches: [] } };
			}
			const list = [...watches.values()].map((w) => ({
				taskId: w.id,
				description: w.description,
				kind: w.kind,
				secondsRunning: Math.round((Date.now() - w.startedAt) / 1000),
				events: w.eventCount,
			}));
			const text = list.map((w) => `- ${w.taskId} [${w.kind}] ${w.description} — ${w.events} events, running ${w.secondsRunning}s`).join("\n");
			return { content: [{ type: "text", text }], details: { watches: list } };
		},
	});

	pi.registerCommand("monitors", {
		description: "List running monitors",
		handler: async (_args, ctx) => {
			if (watches.size === 0) {
				ctx.ui.notify("No running monitors", "info");
				return;
			}
			for (const w of watches.values()) {
				ctx.ui.notify(`${w.id} [${w.kind}] ${w.description} — ${w.eventCount} events, ${Math.round((Date.now() - w.startedAt) / 1000)}s`, "info");
			}
		},
	});

	pi.on("session_shutdown", async () => {
		for (const w of watches.values()) {
			w.closed = true; // suppress final notification on shutdown
			if (w.timeoutId) clearTimeout(w.timeoutId);
			if (w.flushTimer) clearTimeout(w.flushTimer);
			killWatch(w);
		}
		watches = new Map();
	});
}
