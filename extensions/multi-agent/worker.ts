/**
 * Worker: one long-lived `pi --mode rpc` child process.
 *
 * - Speaks the RPC protocol (JSONL commands on stdin, responses + session events on stdout).
 * - Tracks live status, activity, usage, thinking and output for the manager UI.
 * - Writes a human-readable streaming log (<name>.log) that you can `tail -f`,
 *   a lifecycle event log (<name>.events.jsonl), stderr (<name>.stderr.log) and the
 *   final answer of each task (<name>.result.md).
 * - Forwards worker extension dialogs (confirm/select/input/editor) to the manager.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * "interrupted": restored from the manager's session after pi quit while the worker was busy. There is no process;
 * worker_resume / /workers-resume starts a new one on the worker's own session file.
 */
export type WorkerStatus =
	| "starting"
	| "running"
	| "idle"
	| "error"
	| "aborted"
	| "stopped"
	| "crashed"
	| "interrupted";

/**
 * Verdict of the manager's health check on a busy worker (see health.ts). "waiting": a dialog waits for you, which is
 * not a fault, so it is never alerted.
 */
export type HealthState = "ok" | "quiet" | "unresponsive" | "looping" | "waiting";

/** Health check state of one worker. Owned by health.ts; reset when a task starts or settles. */
export interface WorkerHealth {
	state: HealthState;
	/** Start of the current problem: the last event (quiet), the first failed check (unresponsive), the streak start (looping). */
	since?: number;
	detail: string;
	/** Alerts sent over the worker's life. Never reset: a waiting worker_wait compares it to see a new alert. */
	alerts: number;
	/** Alerts sent in the current problem; > 0 means a recovery is worth a toast. */
	episodeAlerts: number;
	nextAlertAt?: number;
	/** A heartbeat is in flight. */
	checking: boolean;
	lastCheckAt?: number;
	lastReplyAt?: number;
	/** Failed heartbeats in a row, and when the first of them was sent. */
	failures: number;
	firstFailureAt?: number;
	/** From the last heartbeat reply (`get_state`). */
	remote?: { isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number };
}

export function freshHealth(alerts = 0): WorkerHealth {
	return { state: "ok", detail: "", alerts, episodeAlerts: 0, checking: false, failures: 0 };
}

/** Payload of the "record" event: persistent state changed. `task` is set when a new task starts. */
export interface RecordEvent {
	task?: string;
}

export type EntryKind = "task" | "message" | "thinking" | "text" | "tool" | "toolResult" | "info" | "error";

export interface TranscriptEntry {
	kind: EntryKind;
	text: string;
	time: number;
	isError?: boolean;
}

export interface DialogRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
}

/** Callbacks the manager provides to a worker. */
export interface WorkerHost {
	/** Forward a blocking dialog to the manager UI. Returns the extension_ui_response fields. */
	dialog(worker: Worker, request: DialogRequest): Promise<Record<string, unknown>>;
	notify(worker: Worker, message: string, level: "info" | "warning" | "error"): void;
}

export interface WorkerConfig {
	name: string;
	cwd: string;
	runDir: string;
	model?: string;
	thinking?: string;
	tools?: string;
	role?: string;
	extraArgs?: string[];
	/** Notify the manager (and trigger a turn) when a task finishes and nobody is waiting on it. */
	notify: boolean;
	/** Open this existing session file (resume) instead of creating a new session. */
	sessionFile?: string;
	/** Create the new session in this directory (`--session-dir`). Ignored with `sessionFile`. */
	sessionDir?: string;
}

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

const MAX_ENTRIES = 400;
const MAX_ENTRY_CHARS = 20_000;
const STDERR_TAIL_CHARS = 8_000;
const START_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 60_000;

const delay = (ms: number) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});

const clock = () => new Date().toLocaleTimeString();

function clip(text: string, max = MAX_ENTRY_CHARS): string {
	return text.length > max ? `…${text.slice(-max)}` : text;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstLines(text: string, lines: number, maxChars: number): string {
	const parts = text.split("\n");
	let out = parts.slice(0, lines).join("\n");
	if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
	else if (parts.length > lines) out += `\n… (${parts.length - lines} more lines)`;
	return out;
}

export function summarizeToolArgs(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	switch (toolName) {
		case "bash":
			return `$ ${oneLine(String(args.command ?? ""), 160)}`;
		case "read":
		case "write":
		case "edit":
			return String(args.path ?? "");
		case "grep":
			return `/${args.pattern ?? ""}/ ${args.path ?? ""}`.trim();
		case "find":
		case "ls":
			return `${args.pattern ?? ""} ${args.path ?? ""}`.trim();
		default:
			try {
				return oneLine(JSON.stringify(args), 160);
			} catch {
				return "";
			}
	}
}

function resultText(result: any): string {
	const content = result?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : ""))
		.join("\n")
		.trim();
}

/**
 * Compact form of an event for <name>.events.jsonl. The session file keeps the full transcript,
 * so drop streaming deltas and the payloads that repeat other records.
 */
function slimEvent(record: any): any | undefined {
	switch (record.type) {
		case "message_update":
		case "tool_execution_update":
			return undefined;
		case "message_start":
			return { type: record.type, role: record.message?.role };
		case "message_end":
			return record.message?.role === "system" ? { type: record.type, role: "system" } : record;
		case "turn_end":
			return {
				type: record.type,
				stopReason: record.message?.stopReason,
				toolResults: Array.isArray(record.toolResults) ? record.toolResults.length : 0,
			};
		case "agent_end":
			return {
				type: record.type,
				willRetry: record.willRetry,
				messages: Array.isArray(record.messages) ? record.messages.length : 0,
			};
		default:
			return record;
	}
}

/** Resolve how to launch pi (same strategy as pi's subagent example). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

type Pending = { resolve: (data: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class Worker extends EventEmitter {
	readonly name: string;
	readonly config: WorkerConfig;
	readonly logPath: string;
	readonly eventsPath: string;
	readonly stderrPath: string;
	readonly resultPath: string;
	readonly rolePath: string;

	status: WorkerStatus = "starting";
	/** True from the moment a task is sent until the worker settles. */
	busy = false;
	pid?: number;
	model?: string;
	thinkingLevel?: string;
	sessionFile?: string;
	sessionId?: string;

	createdAt = Date.now();
	taskStartedAt?: number;
	taskFinishedAt?: number;
	tasks = 0;
	turns = 0;
	toolCalls = 0;
	toolErrors = 0;
	queued = 0;
	usage: WorkerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
	activity = "starting";
	/** Tail of the current/last thinking block (for one-line previews). */
	thinkingTail = "";
	/** Text of the last assistant message that had text. */
	lastText = "";
	/** Final answer of the last finished task. */
	result?: string;
	errorMessage?: string;
	lastStopReason?: string;
	stderrTail = "";
	/** True once the current task's result was handed to the manager (suppresses auto-notify). */
	reported = false;
	transcript: TranscriptEntry[] = [];
	/** Bumped on every change so renderers can cache. */
	version = 0;

	// Inputs of the health check (health.ts).
	/** Last sign of progress: a session event or dialog from the worker, or a new task. RPC responses do not count. */
	lastEventAt = Date.now();
	/** Dialogs waiting for you, the title of the newest one, and when the first one opened. */
	dialogs = 0;
	dialogTitle = "";
	dialogSince?: number;
	/** Identical tool calls (same tool, same arguments) in a row, and when the streak began. */
	repeatCount = 0;
	repeatLabel = "";
	repeatSince?: number;
	health: WorkerHealth = freshHealth();

	private host: WorkerHost;
	private proc?: ChildProcess;
	private pending = new Map<string, Pending>();
	private nextId = 0;
	private log?: fs.WriteStream;
	private events?: fs.WriteStream;
	private stderrLog?: fs.WriteStream;
	/** True once stop() was called (process is being shut down on purpose). */
	stopping = false;
	/** Set when the idle cleanup stopped this worker (idle.ts): how long it had been idle. worker_send revives it. */
	idleStoppedAfterMs?: number;
	private exited = false;
	private exitPromise?: Promise<void>;
	private spawnError?: Error;
	private streamEntries = new Map<number, TranscriptEntry>();
	private streamed = { thinking: false, text: false };
	private repeatKey = "";
	/** Ids of heartbeat requests: their replies stay out of <name>.events.jsonl. */
	private quietIds = new Set<string>();

	constructor(config: WorkerConfig, host: WorkerHost) {
		super();
		this.setMaxListeners(50);
		this.name = config.name;
		this.config = config;
		this.host = host;
		this.logPath = path.join(config.runDir, `${config.name}.log`);
		this.eventsPath = path.join(config.runDir, `${config.name}.events.jsonl`);
		this.stderrPath = path.join(config.runDir, `${config.name}.stderr.log`);
		this.resultPath = path.join(config.runDir, `${config.name}.result.md`);
		this.rolePath = path.join(config.runDir, `${config.name}.role.md`);
		this.model = config.model;
		this.thinkingLevel = config.thinking;
	}

	get alive(): boolean {
		return !!this.proc && !this.exited;
	}

	get elapsedMs(): number {
		if (!this.taskStartedAt) return 0;
		return (this.busy ? Date.now() : (this.taskFinishedAt ?? Date.now())) - this.taskStartedAt;
	}

	// ---------------------------------------------------------------- lifecycle

	async start(): Promise<void> {
		fs.mkdirSync(this.config.runDir, { recursive: true });
		this.log = fs.createWriteStream(this.logPath, { flags: "a" });
		this.events = fs.createWriteStream(this.eventsPath, { flags: "a" });
		this.stderrLog = fs.createWriteStream(this.stderrPath, { flags: "a" });

		const args = ["--mode", "rpc", "--name", `worker:${this.name}`];
		if (this.config.sessionFile) args.push("--session", this.config.sessionFile);
		else if (this.config.sessionDir) args.push("--session-dir", this.config.sessionDir);
		if (this.config.model) args.push("--model", this.config.model);
		if (this.config.thinking) args.push("--thinking", this.config.thinking);
		if (this.config.tools) args.push("--tools", this.config.tools);
		if (this.config.role?.trim()) {
			fs.writeFileSync(this.rolePath, this.config.role, "utf8");
			args.push("--append-system-prompt", this.rolePath);
		}
		if (this.config.extraArgs?.length) args.push(...this.config.extraArgs);

		const invocation = getPiInvocation(args);
		this.writeLog(
			`\n████ ${clock()} worker "${this.name}" starting\n` +
				`cwd: ${this.config.cwd}\ncmd: ${invocation.command} ${invocation.args.join(" ")}\n`,
		);

		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.config.cwd,
			env: { ...process.env, PI_MULTI_AGENT_ROLE: "worker", PI_MULTI_AGENT_WORKER: this.name },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		this.pid = proc.pid;
		this.exitPromise = new Promise<void>((resolve) => {
			proc.once("close", (code, signal) => {
				this.handleExit(code, signal);
				resolve();
			});
		});
		proc.on("error", (error) => {
			this.spawnError = error;
		});
		proc.stdin?.on("error", () => {
			/* EPIPE after exit: handled by close */
		});

		// Strict JSONL framing: split on LF only (not U+2028/U+2029 like readline would).
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.handleLine(line);
				newline = buffer.indexOf("\n");
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			this.stderrLog?.write(text);
			this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
		});

		const state = await this.request({ type: "get_state" }, START_TIMEOUT_MS);
		this.sessionFile = state?.sessionFile;
		this.sessionId = state?.sessionId;
		if (state?.model?.provider && state?.model?.id) this.model = `${state.model.provider}/${state.model.id}`;
		if (state?.thinkingLevel) this.thinkingLevel = state.thinkingLevel;
		this.status = "idle";
		this.activity = "ready";
		this.writeLog(`model: ${this.model ?? "?"} (thinking ${this.thinkingLevel ?? "?"})\nsession: ${this.sessionFile ?? "(none)"}\n`);
		this.changed();
	}

	/** Abort the current task (if any), then shut the process down, escalating to signals. */
	async stop(): Promise<void> {
		if (!this.proc || this.exited) return;
		this.stopping = true;
		this.activity = "stopping";
		this.changed();
		const exited = this.exitPromise ?? Promise.resolve();
		const waitExit = (ms: number) => Promise.race([exited.then(() => true), delay(ms).then(() => false)]);

		if (this.busy) await this.request({ type: "abort" }, 5_000).catch(() => undefined);
		try {
			this.proc.stdin?.end();
		} catch {
			/* ignore */
		}
		if (await waitExit(3_000)) return;
		this.proc.kill("SIGTERM");
		if (await waitExit(2_000)) return;
		this.proc.kill("SIGTERM"); // a second signal makes pi exit at once
		if (await waitExit(2_000)) return;
		this.proc.kill("SIGKILL");
		await waitExit(1_000);
	}

	// ---------------------------------------------------------------- commands

	/** Send a command and resolve with its response data. `quiet`: keep the response out of the events log. */
	request(command: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS, quiet = false): Promise<any> {
		if (!this.proc || this.exited || !this.proc.stdin?.writable) {
			return Promise.reject(new Error(`worker "${this.name}" is not running`));
		}
		const id = `ma-${++this.nextId}`;
		if (quiet) this.quietIds.add(id);
		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							this.quietIds.delete(id);
							reject(new Error(`worker "${this.name}": ${String(command.type)} timed out`));
						}, timeoutMs)
					: undefined;
			this.pending.set(id, { resolve, reject, timer });
			this.write({ ...command, id });
		});
	}

	/** Heartbeat for the health check: `get_state`, answered by a live RPC loop even while a task runs. */
	ping(timeoutMs: number): Promise<any> {
		return this.request({ type: "get_state" }, timeoutMs, true);
	}

	/** Start a new task (worker must be idle). */
	async prompt(text: string, label = "TASK"): Promise<void> {
		if (this.busy) throw new Error(`worker "${this.name}" is busy; steer or follow up instead`);
		this.busy = true;
		this.status = "running";
		this.activity = "waiting for model";
		this.taskStartedAt = Date.now();
		this.taskFinishedAt = undefined;
		this.tasks++;
		this.reported = false;
		this.result = undefined;
		this.errorMessage = undefined;
		this.lastStopReason = undefined;
		this.lastText = "";
		this.thinkingTail = "";
		this.lastEventAt = Date.now();
		this.resetRepeat();
		this.health = freshHealth(this.health.alerts);
		this.addEntry(label === "TASK" ? "task" : "message", text);
		this.writeLog(`\n━━━━ ${clock()} ${label} ━━━━\n${text}\n`);
		this.changed();
		// Record before sending, so a quit at any later moment finds the worker busy. A resume prompt is not a new task.
		this.emit("record", (label === "RESUME" ? {} : { task: text }) satisfies RecordEvent);
		try {
			const data = await this.request({ type: "prompt", message: text });
			if (data?.disposition === "handled") {
				this.busy = false;
				this.status = "idle";
				this.activity = "prompt was handled by an extension command";
				this.taskFinishedAt = Date.now();
				this.changed();
				this.emit("record", {} satisfies RecordEvent);
			}
		} catch (error) {
			this.busy = false;
			this.status = "error";
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.activity = `error: ${this.errorMessage}`;
			this.taskFinishedAt = Date.now();
			this.changed();
			this.emit("record", {} satisfies RecordEvent);
			throw error;
		}
	}

	/** Message the worker: new task when idle, otherwise steer or queue a follow-up. */
	async send(text: string, mode: "steer" | "followUp"): Promise<"started" | "queued" | "handled"> {
		if (!this.busy) {
			await this.prompt(text, "MESSAGE");
			return "started";
		}
		this.reported = false;
		this.addEntry("message", `[${mode}] ${text}`);
		this.writeLog(`\n✉ ${clock()} ${mode.toUpperCase()}: ${text}\n`);
		this.changed();
		const data = await this.request({ type: mode === "steer" ? "steer" : "follow_up", message: text });
		return data?.disposition === "handled" ? "handled" : "queued";
	}

	async abort(): Promise<void> {
		if (!this.busy) return;
		this.activity = "aborting";
		this.changed();
		await this.request({ type: "abort" }, 30_000);
	}

	// ---------------------------------------------------------------- protocol

	private write(record: Record<string, unknown>): void {
		try {
			this.proc?.stdin?.write(`${JSON.stringify(record)}\n`);
		} catch {
			/* process gone; close handler reports it */
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let record: any;
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		const heartbeat = record.type === "response" && this.quietIds.delete(record.id);
		const slim = heartbeat ? undefined : slimEvent(record);
		if (slim) {
			this.events?.write(`${JSON.stringify({ t: Date.now(), ...slim })}\n`);
		}
		if (record.type === "response") {
			this.handleResponse(record);
		} else if (record.type === "extension_ui_request") {
			void this.handleUiRequest(record);
		} else {
			this.handleEvent(record);
		}
	}

	private handleResponse(record: any): void {
		const pending = record.id ? this.pending.get(record.id) : undefined;
		if (!pending) return;
		this.pending.delete(record.id);
		if (pending.timer) clearTimeout(pending.timer);
		if (record.success) pending.resolve(record.data);
		else pending.reject(new Error(record.error ?? `${record.command} failed`));
	}

	private async handleUiRequest(request: any): Promise<void> {
		const method = request.method;
		if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
			const previous = this.activity;
			this.lastEventAt = Date.now();
			if (this.dialogs++ === 0) this.dialogSince = Date.now();
			this.dialogTitle = String(request.title ?? method);
			this.activity = `waiting for you: ${request.title ?? method}`;
			this.addEntry("info", `dialog (${method}): ${request.title ?? ""} ${request.message ?? ""}`.trim());
			this.writeLog(`\n? ${clock()} dialog (${method}): ${request.title ?? ""} ${request.message ?? ""}\n`);
			this.changed();
			let response: Record<string, unknown>;
			try {
				response = await this.host.dialog(this, request as DialogRequest);
			} catch {
				response = { cancelled: true };
			}
			if (--this.dialogs <= 0) {
				this.dialogs = 0;
				this.dialogSince = undefined;
			}
			// The answer is progress too: the time spent waiting for you is not the worker being quiet.
			this.lastEventAt = Date.now();
			this.write({ type: "extension_ui_response", id: request.id, ...response });
			this.writeLog(`  → ${JSON.stringify(response)}\n`);
			if (this.activity.startsWith("waiting for you")) this.activity = previous;
			this.changed();
		} else if (method === "notify") {
			this.lastEventAt = Date.now();
			const level = request.notifyType === "error" || request.notifyType === "warning" ? request.notifyType : "info";
			this.addEntry(level === "error" ? "error" : "info", `notify: ${request.message ?? ""}`);
			this.writeLog(`\n• ${clock()} notify (${level}): ${request.message ?? ""}\n`);
			this.host.notify(this, String(request.message ?? ""), level);
			this.changed();
		}
		// setStatus / setWidget / setTitle / set_editor_text: ignored.
	}

	private handleEvent(event: any): void {
		this.lastEventAt = Date.now(); // any session event, streaming deltas included, shows the worker is moving
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.status = "running";
				break;
			case "turn_start":
				this.turns++;
				this.activity = "waiting for model";
				this.writeLog(`\n── turn ${this.turns} ──\n`);
				break;
			case "message_start":
				if (event.message?.role !== "assistant") return;
				this.streamEntries.clear();
				this.streamed = { thinking: false, text: false };
				break;
			case "message_update":
				if (!this.handleDelta(event.assistantMessageEvent)) return;
				break;
			case "message_end":
				if (!this.handleMessageEnd(event.message)) return;
				break;
			case "tool_execution_start": {
				this.toolCalls++;
				const summary = summarizeToolArgs(event.toolName, event.args);
				this.countRepeat(event.toolName, event.args, `${event.toolName} ${summary}`.trim());
				this.activity = `${event.toolName} ${summary}`.trim();
				this.addEntry("tool", `${event.toolName} ${summary}`.trim());
				this.writeLog(`\n▶ ${event.toolName} ${summary}\n`);
				break;
			}
			case "tool_execution_end": {
				if (event.isError) this.toolErrors++;
				const text = resultText(event.result);
				const took = typeof event.durationMs === "number" ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : "";
				this.addEntry("toolResult", `${took.trim()} ${firstLines(text, 6, 800)}`.trim(), !!event.isError);
				this.writeLog(`  ${event.isError ? "✗" : "✓"}${took} ${firstLines(text, 3, 400).replace(/\n/g, "\n    ")}\n`);
				this.activity = "waiting for model";
				break;
			}
			case "queue_update":
				this.queued = (event.steering?.length ?? 0) + (event.followUp?.length ?? 0);
				break;
			case "compaction_start":
				this.activity = `compacting context (${event.reason})`;
				this.addEntry("info", this.activity);
				this.writeLog(`\n• ${clock()} ${this.activity}\n`);
				break;
			case "compaction_end": {
				const info = event.aborted
					? "compaction aborted"
					: event.errorMessage
						? `compaction failed: ${event.errorMessage}`
						: `compacted ${event.result?.tokensBefore ?? "?"} → ~${event.result?.estimatedTokensAfter ?? "?"} tokens`;
				this.addEntry("info", info);
				this.writeLog(`• ${info}\n`);
				break;
			}
			case "auto_retry_start":
				this.activity = `retry ${event.attempt}/${event.maxAttempts} in ${Math.round((event.delayMs ?? 0) / 1000)}s: ${oneLine(String(event.errorMessage ?? ""), 120)}`;
				this.addEntry("info", this.activity);
				this.writeLog(`\n• ${clock()} ${this.activity}\n`);
				break;
			case "auto_retry_end":
				if (event.success) break;
				this.errorMessage = event.finalError ?? "retries exhausted";
				this.addEntry("error", `retry failed: ${this.errorMessage}`);
				this.writeLog(`\n✗ retry failed: ${this.errorMessage}\n`);
				break;
			case "agent_settled":
				this.handleSettled(!!event.aborted);
				return;
			default:
				return;
		}
		this.changed();
	}

	/** Returns true if state changed. */
	private handleDelta(e: any): boolean {
		if (!e) return false;
		switch (e.type) {
			case "thinking_start":
				this.streamed.thinking = true;
				this.activity = "thinking";
				this.thinkingTail = "";
				this.streamEntries.set(e.contentIndex, this.addEntry("thinking", ""));
				this.writeLog("\n┊ ");
				return true;
			case "thinking_delta": {
				const delta = String(e.delta ?? "");
				const entry = this.streamEntry(e.contentIndex, "thinking");
				entry.text = clip(entry.text + delta);
				this.thinkingTail = (this.thinkingTail + delta).slice(-600);
				this.writeLog(delta.replace(/\n/g, "\n┊ "));
				return true;
			}
			case "thinking_end": {
				const entry = this.streamEntries.get(e.contentIndex);
				if (entry && typeof e.content === "string") entry.text = clip(e.content);
				this.writeLog("\n");
				return true;
			}
			case "text_start":
				this.streamed.text = true;
				this.activity = "writing";
				this.streamEntries.set(e.contentIndex, this.addEntry("text", ""));
				this.writeLog("\n│ ");
				return true;
			case "text_delta": {
				const delta = String(e.delta ?? "");
				const entry = this.streamEntry(e.contentIndex, "text");
				entry.text = clip(entry.text + delta);
				this.writeLog(delta.replace(/\n/g, "\n│ "));
				return true;
			}
			case "text_end": {
				const entry = this.streamEntries.get(e.contentIndex);
				if (entry && typeof e.content === "string") entry.text = clip(e.content);
				this.writeLog("\n");
				return true;
			}
			case "toolcall_start":
				this.activity = `calling ${e.toolName ?? "tool"}`;
				return true;
			default:
				return false;
		}
	}

	private handleMessageEnd(message: any): boolean {
		if (!message || message.role !== "assistant") return false;
		const u = message.usage;
		if (u) {
			this.usage.input += u.input ?? 0;
			this.usage.output += u.output ?? 0;
			this.usage.cacheRead += u.cacheRead ?? 0;
			this.usage.cacheWrite += u.cacheWrite ?? 0;
			this.usage.cost += u.cost?.total ?? 0;
			if (u.totalTokens) this.usage.contextTokens = u.totalTokens;
		}
		if (message.provider && message.model) this.model = `${message.provider}/${message.model}`;
		this.lastStopReason = message.stopReason;
		if (message.stopReason === "error") {
			this.errorMessage = message.errorMessage ?? "model error";
			this.addEntry("error", this.errorMessage!);
			this.writeLog(`\n✗ ${this.errorMessage}\n`);
		}
		const blocks: any[] = Array.isArray(message.content) ? message.content : [];
		// Some providers do not stream every block type; record what we missed.
		if (!this.streamed.thinking) {
			for (const b of blocks) {
				if (b?.type !== "thinking") continue;
				const text = b.redacted && !b.thinking ? "[redacted thinking]" : String(b.thinking ?? "");
				if (!text.trim()) continue;
				this.addEntry("thinking", clip(text));
				this.thinkingTail = text.slice(-600);
				this.writeLog(`\n┊ ${text.replace(/\n/g, "\n┊ ")}\n`);
			}
		}
		if (!this.streamed.text) {
			for (const b of blocks) {
				if (b?.type !== "text" || !String(b.text ?? "").trim()) continue;
				this.addEntry("text", clip(String(b.text)));
				this.writeLog(`\n│ ${String(b.text).replace(/\n/g, "\n│ ")}\n`);
			}
		}
		const text = blocks
			.filter((b) => b?.type === "text")
			.map((b) => String(b.text ?? ""))
			.join("\n")
			.trim();
		if (text) this.lastText = text;
		return true;
	}

	private handleSettled(aborted: boolean): void {
		this.busy = false;
		this.queued = 0;
		this.health = freshHealth(this.health.alerts);
		this.taskFinishedAt = Date.now();
		this.status = aborted ? "aborted" : this.lastStopReason === "error" ? "error" : "idle";
		this.result = this.lastText || undefined;
		this.activity =
			this.status === "idle" ? "done" : this.status === "aborted" ? "aborted" : `error: ${this.errorMessage ?? "?"}`;
		this.writeLog(`\n━━━━ ${clock()} ${this.status.toUpperCase()} after ${(this.elapsedMs / 1000).toFixed(1)}s ━━━━\n`);
		try {
			fs.writeFileSync(this.resultPath, this.result ?? "", "utf8");
		} catch {
			/* ignore */
		}
		this.changed();
		this.emit("record", {} satisfies RecordEvent);
		this.emit("settled", this);
	}

	private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.exited = true;
		const wasBusy = this.busy;
		this.busy = false;
		this.health = freshHealth(this.health.alerts);
		this.quietIds.clear();
		const reason = this.spawnError
			? `failed to start pi: ${this.spawnError.message}`
			: `pi exited (code ${code ?? "null"}, signal ${signal ?? "none"})`;
		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error(`worker "${this.name}": ${reason}${this.stderrTail ? `\n${this.stderrTail.slice(-1500)}` : ""}`));
		}
		this.pending.clear();
		if (this.stopping) {
			this.status = "stopped";
			this.activity = "stopped";
		} else {
			this.status = "crashed";
			this.errorMessage = `${reason}${this.stderrTail ? `. stderr: ${this.stderrTail.slice(-1500)}` : ""}`;
			this.activity = reason;
			this.addEntry("error", this.errorMessage);
		}
		if (wasBusy) this.taskFinishedAt = Date.now();
		this.writeLog(`\n████ ${clock()} ${this.status}: ${reason}\n`);
		this.log?.end();
		this.events?.end();
		this.stderrLog?.end();
		this.changed();
		this.emit("record", {} satisfies RecordEvent);
		if (wasBusy) this.emit("settled", this);
		this.emit("exit", this);
	}

	// ---------------------------------------------------------------- helpers

	/** Count identical tool calls in a row. Full arguments, so edits to one file with different text do not count. */
	private countRepeat(toolName: string, args: unknown, label: string): void {
		let key: string;
		try {
			key = `${toolName}\u0000${JSON.stringify(args ?? null)}`;
		} catch {
			key = `${toolName}\u0000${label}`;
		}
		if (key === this.repeatKey) {
			this.repeatCount++;
			return;
		}
		this.repeatKey = key;
		this.repeatCount = 1;
		this.repeatLabel = label;
		this.repeatSince = Date.now();
	}

	private resetRepeat(): void {
		this.repeatKey = "";
		this.repeatCount = 0;
		this.repeatLabel = "";
		this.repeatSince = undefined;
	}

	private streamEntry(index: number, kind: EntryKind): TranscriptEntry {
		let entry = this.streamEntries.get(index);
		if (!entry) {
			entry = this.addEntry(kind, "");
			this.streamEntries.set(index, entry);
		}
		return entry;
	}

	private addEntry(kind: EntryKind, text: string, isError = false): TranscriptEntry {
		const entry: TranscriptEntry = { kind, text: clip(text), time: Date.now(), isError };
		this.transcript.push(entry);
		if (this.transcript.length > MAX_ENTRIES) this.transcript.splice(0, this.transcript.length - MAX_ENTRIES);
		return entry;
	}

	private writeLog(text: string): void {
		if (this.log && !this.log.writableEnded) this.log.write(text);
	}

	private changed(): void {
		this.version++;
		this.emit("change", this);
	}
}
