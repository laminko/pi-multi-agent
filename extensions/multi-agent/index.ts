/**
 * multi-agent: a manager pi that runs worker pis.
 *
 * Each worker is a long-lived `pi --mode rpc` process with its own context window,
 * model and tools. The manager LLM gets worker_* tools; you get a live widget,
 * a /workers viewer (thinking, output, tool calls), per-worker log files and the
 * workers' normal pi session files.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detailReport, fmtDuration, oneLine, STATUS_LABEL, STATUS_LEGEND, statusTable } from "./format.ts";
import {
	assessHealth,
	describeHealthConfig,
	healthAlertText,
	healthFollowUp,
	healthTitle,
	heartbeat,
	readHealthConfig,
	updateHealth,
} from "./health.ts";
import { describeIdleConfig, idleSince, readIdleConfig, shouldReap } from "./idle.ts";
import { formatResultBlock, formatRunningBlock, renderReport } from "./report.ts";
import {
	INTERRUPTED_NOTE,
	interruptedRecords,
	mergeRecords,
	oldProcessAlive,
	RECORD_TYPE,
	RESUME_PROMPT,
	repairSession,
	type WorkerRecord,
} from "./resume.ts";
import { createViewer, createWidgetComponent, type ViewerAction, widgetLines } from "./ui.ts";
import { type DialogRequest, type RecordEvent, Worker, type WorkerHost } from "./worker.ts";

const WIDGET_KEY = "multi-agent";
const MESSAGE_TYPE = "multi-agent";
/** Hidden note to the manager LLM about interrupted workers (delivered with the next user prompt). */
const NOTE_TYPE = "multi-agent-note";
/** Health check alert: a worker may be stuck (see health.ts). */
const HEALTH_TYPE = "multi-agent-health";
const MAX_LIVE_WORKERS = Number(process.env.PI_MULTI_AGENT_MAX_WORKERS) || 8;
const RESULT_BUDGET_BYTES = 40_000; // per tool result, shared by the workers it reports on
const DEFAULT_WAIT_SECONDS = 1800;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

class Registry extends EventEmitter {
	readonly workers = new Map<string, Worker>();
	list(): Worker[] {
		return [...this.workers.values()];
	}
}

function sanitizeName(raw: string): string {
	const name = raw
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	if (!name) throw new Error(`Invalid worker name: "${raw}"`);
	return name;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

function snapshot(w: Worker) {
	return {
		name: w.name,
		status: w.status,
		busy: w.busy,
		pid: w.pid,
		turns: w.turns,
		toolCalls: w.toolCalls,
		cost: w.usage.cost,
		logPath: w.logPath,
		sessionFile: w.sessionFile,
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).join("\n");
}

export default function multiAgent(pi: ExtensionAPI) {
	// Workers load the same extensions; they must not manage workers of their own.
	if (process.env.PI_MULTI_AGENT_ROLE === "worker") return;

	const registry = new Registry();
	registry.setMaxListeners(100);
	const waiting = new Map<string, number>(); // worker name -> number of active waiters
	const extraWorkerArgs = (process.env.PI_MULTI_AGENT_WORKER_ARGS ?? "").split(/\s+/).filter(Boolean);
	const multiAgentRoot = () => process.env.PI_MULTI_AGENT_DIR || path.join(getAgentDir(), "multi-agent");
	// New workers keep their sessions out of the project's session list, so `pi -c` / `pi -r` find the manager.
	// Session flags in PI_MULTI_AGENT_WORKER_ARGS win.
	const userSessionArgs = extraWorkerArgs.some((a) => a === "--session-dir" || a === "--no-session" || a === "--session");
	const workerSessionDir = () =>
		userSessionArgs
			? undefined
			: process.env.PI_MULTI_AGENT_WORKER_SESSION_DIR || path.join(multiAgentRoot(), "sessions");
	/** Set in session_shutdown: stopping workers then is not a state change worth recording. */
	let shuttingDown = false;
	/** Last records of the workers restored as interrupted at session_start, by name. */
	const interrupted = new Map<string, WorkerRecord>();
	/** Tell the manager LLM about interrupted workers at the start of its next run (see before_agent_start). */
	let interruptedNoteDue = false;
	/** Names being resumed right now (a resume replaces the worker object). */
	const resuming = new Set<string>();
	/**
	 * Working = busy, or about to be: starting up, or being resumed. A wait must not count these as finished; the
	 * model often calls worker_wait in the same message as worker_spawn / worker_resume, and those run in parallel.
	 */
	const working = (w: Worker) => w.busy || w.status === "starting" || resuming.has(w.name);
	/** The current worker of that name: a resume or respawn replaces the object while someone may hold the old one. */
	const latest = (w: Worker) => registry.workers.get(w.name) ?? w;

	let uiCtx: ExtensionContext | undefined;
	let runDir: string | undefined;
	let widgetTui: { requestRender(): void } | undefined;
	let widgetMode: "none" | "component" | "lines" = "none";
	let viewerOpen = false;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	/** Health checks (health.ts): PI_MULTI_AGENT_HEALTH_INTERVAL (default 10 s), PI_MULTI_AGENT_STALL_SECONDS (180 s). */
	const healthConfig = readHealthConfig();
	let healthTimer: ReturnType<typeof setInterval> | undefined;
	/** Idle cleanup (idle.ts): PI_MULTI_AGENT_IDLE_MINUTES (default 10; 0 = off). */
	const idleConfig = readIdleConfig();
	let idleTimer: ReturnType<typeof setInterval> | undefined;

	// ------------------------------------------------------------ UI plumbing

	function refreshWidget(): void {
		const ctx = uiCtx;
		if (!ctx?.hasUI) return;
		try {
			if (registry.workers.size === 0 || viewerOpen) {
				if (widgetMode !== "none") ctx.ui.setWidget(WIDGET_KEY, undefined);
				widgetMode = "none";
				widgetTui = undefined;
				return;
			}
			if (ctx.mode === "tui") {
				if (widgetMode !== "component") {
					ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
						widgetTui = tui;
						return createWidgetComponent(registry, theme, (name) => {
							const c = uiCtx;
							if (c && !viewerOpen) void openViewer(c, name).catch(() => undefined);
						});
					});
					widgetMode = "component";
				}
				widgetTui?.requestRender();
			} else {
				// RPC hosts (IDEs, web UIs) only support plain string widgets.
				ctx.ui.setWidget(WIDGET_KEY, widgetLines(registry, 140));
				widgetMode = "lines";
			}
		} catch {
			/* stale context during shutdown */
		}
	}

	function scheduleWidget(): void {
		if (renderTimer) return;
		const ms = uiCtx?.mode === "tui" ? 100 : 1000;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			refreshWidget();
		}, ms);
	}

	registry.on("change", scheduleWidget);

	function getRunDir(ctx: ExtensionContext): string {
		if (runDir) return runDir;
		const root = multiAgentRoot();
		const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..*$/, "");
		const sid = (ctx.sessionManager.getSessionId() ?? "nosession").slice(0, 8);
		runDir = path.join(root, "runs", `${stamp}-${sid}`);
		fs.mkdirSync(runDir, { recursive: true });
		const latest = path.join(root, "latest");
		try {
			fs.rmSync(latest, { force: true });
			fs.symlinkSync(runDir, latest, "dir");
		} catch {
			/* best effort */
		}
		return runDir;
	}

	// ------------------------------------------------------------ worker host

	const host: WorkerHost = {
		async dialog(worker: Worker, req: DialogRequest) {
			const ctx = uiCtx;
			if (!ctx?.hasUI) return { cancelled: true };
			const title = `[worker ${worker.name}] ${req.title ?? ""}`.trim();
			const opts = req.timeout ? { timeout: req.timeout } : undefined;
			switch (req.method) {
				case "select": {
					const value = await ctx.ui.select(title, req.options ?? [], opts);
					return value === undefined ? { cancelled: true } : { value };
				}
				case "confirm":
					return { confirmed: !!(await ctx.ui.confirm(title, req.message ?? "", opts)) };
				case "input": {
					const value = await ctx.ui.input(title, req.placeholder, opts);
					return value === undefined ? { cancelled: true } : { value };
				}
				case "editor": {
					const value = await ctx.ui.editor(title, req.prefill);
					return value === undefined ? { cancelled: true } : { value };
				}
				default:
					return { cancelled: true };
			}
		},
		notify(worker: Worker, message: string, level) {
			// Info-level notices from workers stay in the worker transcript; surface only problems.
			if (level === "info" || !uiCtx?.hasUI) return;
			try {
				uiCtx.ui.notify(`[worker ${worker.name}] ${message}`, level);
			} catch {
				/* ignore */
			}
		},
	};

	// ------------------------------------------------------------ worker lifecycle

	function onSettled(w: Worker): void {
		if (w.stopping) return;
		// Tell the user at once, even while the manager is busy with another turn.
		try {
			if (uiCtx?.hasUI) {
				const ok = w.status === "idle"; // "idle" is the settled-OK status; its label is "done"
				uiCtx.ui.notify(`Worker ${w.name} ${STATUS_LABEL[w.status]}`, ok ? "info" : "warning");
			}
		} catch {
			/* stale context */
		}
		if (w.reported || !w.config.notify) return;
		if ((waiting.get(w.name) ?? 0) > 0) return; // a worker_wait call will report it
		w.reported = true;
		const status = STATUS_LABEL[w.status];
		try {
			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: `Worker "${w.name}" finished (${status}).\n\n${formatResultBlock(w, RESULT_BUDGET_BYTES)}`,
					display: true,
					details: { name: w.name, status },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* session gone */
		}
	}

	// ------------------------------------------------------------ health checks (see health.ts)

	function toast(message: string, level: "info" | "warning"): void {
		try {
			if (uiCtx?.hasUI) uiCtx.ui.notify(message, level);
		} catch {
			/* stale context */
		}
	}

	/**
	 * Follow up on every busy worker: heartbeat, verdict, and an alert when it may be stuck. Runs every
	 * healthConfig.intervalMs; costs no model tokens unless an alert goes to the manager LLM.
	 */
	async function checkHealth(): Promise<void> {
		if (shuttingDown) return;
		const targets = registry.list().filter((w) => w.busy && w.alive && !w.stopping);
		await Promise.all(
			targets.map(async (w) => {
				await heartbeat(w, healthConfig);
				// The worker may have settled, been stopped or replaced while the heartbeat was out.
				if (shuttingDown || !w.busy || w.stopping || registry.workers.get(w.name) !== w) return;
				const now = Date.now();
				const action = updateHealth(w, assessHealth(w, now, healthConfig), now, healthConfig);
				if (action.kind === "none") return;
				registry.emit("change");
				if (action.kind === "alert") alertManager(w, action.repeat);
				else if (action.kind === "recovered" && action.alerted) toast(`Worker ${w.name} is making progress again`, "info");
			}),
		);
	}

	/** Tell you at once, and the manager LLM so it follows up (same delivery rules as a result). */
	function alertManager(w: Worker, repeat: boolean): void {
		const h = w.health;
		toast(`Worker ${w.name} ${repeat ? "is still" : "may be"} stuck (${healthTitle(h.state)}): ${oneLine(h.detail, 200)}`, "warning");
		if (!w.config.notify) return; // notify=false: worker_wait / worker_status show the health instead
		if ((waiting.get(w.name) ?? 0) > 0) return; // the waiting worker_wait returns "stalled" with this alert
		try {
			pi.sendMessage(
				{
					customType: HEALTH_TYPE,
					content: healthAlertText(w, healthConfig, repeat),
					display: true,
					details: { name: w.name, state: h.state, title: healthTitle(h.state), detail: h.detail, repeat },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* session gone */
		}
	}

	// ------------------------------------------------------------ idle cleanup (see idle.ts)

	/** Stop the processes of workers that were not reused for idleConfig.idleMs. They stay listed and can be revived. */
	async function reapIdle(): Promise<void> {
		if (shuttingDown) return;
		const now = Date.now();
		const targets = registry
			.list()
			.filter((w) => !resuming.has(w.name) && shouldReap(w, now, idleConfig, (waiting.get(w.name) ?? 0) > 0));
		await Promise.all(
			targets.map(async (w) => {
				const idleMs = now - idleSince(w);
				w.idleStoppedAfterMs = idleMs;
				await w.stop().catch(() => undefined);
				if (shuttingDown) return;
				w.activity = `stopped after ${fmtDuration(idleMs)} idle · worker_send revives it`;
				w.transcript.push({
					kind: "info",
					text: `Idle cleanup: process stopped after ${fmtDuration(idleMs)} without a task. worker_send starts it again on its session (${w.sessionFile ?? "no session file: fresh context"}).`,
					time: Date.now(),
				});
				w.version++;
				registry.emit("change");
				toast(`Worker ${w.name} stopped after ${fmtDuration(idleMs)} idle`, "info");
			}),
		);
	}

	/** True for a worker whose process the idle cleanup stopped: worker_send starts it again. */
	const revivable = (w: Worker) => w.status === "stopped" && w.idleStoppedAfterMs !== undefined && !w.alive;

	/** Start an idle-stopped worker again on its own session file, with its old settings. */
	async function revive(ctx: ExtensionContext, w: Worker): Promise<Worker> {
		const c = w.config;
		const session = w.sessionFile && fs.existsSync(w.sessionFile) ? w.sessionFile : undefined;
		resuming.add(w.name);
		try {
			const worker = await spawnWorker(ctx, {
				name: w.name,
				cwd: c.cwd,
				model: w.model ?? c.model,
				thinking: w.thinkingLevel ?? c.thinking,
				tools: c.tools,
				role: c.role,
				notify: c.notify,
				resumeSession: session,
			});
			// Keep the viewer history and the life-time counters of the old process.
			worker.transcript = [...w.transcript, ...worker.transcript].slice(-400);
			worker.tasks += w.tasks;
			worker.turns += w.turns;
			worker.toolCalls += w.toolCalls;
			worker.toolErrors += w.toolErrors;
			for (const k of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) worker.usage[k] += w.usage[k];
			worker.version++;
			registry.emit("change");
			return worker;
		} finally {
			resuming.delete(w.name);
		}
	}

	/** worker_send / viewer / command: wait for a stop in progress by the idle cleanup, then revive if needed. */
	async function ensureLive(ctx: ExtensionContext, w: Worker): Promise<Worker> {
		for (let i = 0; i < 150 && w.idleStoppedAfterMs !== undefined && w.alive && w.stopping; i++) await abortableSleep(100);
		return revivable(w) ? revive(ctx, w) : w;
	}

	function register(worker: Worker): void {
		worker.on("change", () => registry.emit("change"));
		worker.on("settled", () => onSettled(worker));
		worker.on("record", (event: RecordEvent) => recordWorker(worker, event));
		registry.workers.set(worker.name, worker);
		registry.emit("change");
	}

	// ------------------------------------------------------------ records and resume (see resume.ts)

	/** Append the worker's state to the manager's session, so it can be resumed after pi quits. */
	function recordWorker(w: Worker, event: RecordEvent): void {
		if (shuttingDown) return;
		const c = w.config;
		const record: WorkerRecord = {
			v: 1,
			name: w.name,
			status: w.status,
			busy: w.busy,
			at: Date.now(),
			options: { cwd: c.cwd, model: c.model, thinking: c.thinking, tools: c.tools, role: c.role, notify: c.notify },
			task: event.task,
			sessionFile: w.sessionFile,
			pid: w.pid,
			logPath: w.logPath,
		};
		try {
			pi.appendEntry(RECORD_TYPE, record);
		} catch {
			/* session gone */
		}
	}

	/** Stop offering an interrupted worker for resume. */
	function dismiss(w: Worker): void {
		if (w.status !== "interrupted") return;
		w.status = "stopped";
		w.activity = "dismissed";
		interrupted.delete(w.name);
		recordWorker(w, {});
		registry.emit("change");
	}

	/** Rebuild the workers that were busy when pi quit, as "interrupted" entries without a process. */
	function restoreInterrupted(ctx: ExtensionContext): void {
		interrupted.clear();
		let records: WorkerRecord[];
		try {
			records = interruptedRecords(mergeRecords(ctx.sessionManager.getBranch() as any[]));
		} catch {
			return;
		}
		for (const rec of records) {
			if (registry.workers.get(rec.name)?.alive) continue;
			const o = rec.options ?? { cwd: ctx.cwd, notify: true };
			const w = new Worker(
				{
					name: rec.name,
					cwd: o.cwd,
					runDir: rec.logPath ? path.dirname(rec.logPath) : multiAgentRoot(),
					model: o.model,
					thinking: o.thinking,
					tools: o.tools,
					role: o.role,
					notify: o.notify,
				},
				host,
			);
			w.status = "interrupted";
			w.sessionFile = rec.sessionFile;
			w.model = o.model;
			w.thinkingLevel = o.thinking;
			w.activity = "interrupted";
			const time = rec.at ?? Date.now();
			if (rec.task) w.transcript.push({ kind: "task", text: rec.task, time });
			w.transcript.push({
				kind: "info",
				text:
					"Interrupted: pi quit while this worker was busy. /workers-resume (or asking the manager) continues it " +
					(rec.sessionFile ? "in its own session, with its context." : "by restarting its task (it has no session file).") +
					` Log of the interrupted run: ${rec.logPath ?? "?"}`,
				time,
			});
			register(w);
			interrupted.set(rec.name, rec);
		}
		if (interrupted.size === 0) return;
		const names = [...interrupted.keys()];
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${names.length} worker(s) were interrupted when pi quit: ${names.join(", ")}. /workers-resume continues them.`,
				"warning",
			);
		}
		interruptedNoteDue = true;
	}

	/**
	 * Note for the manager LLM, built when its next run starts rather than at session_start: if the user resumed or
	 * dismissed the workers in between, there is nothing to say (a note queued earlier would be stale).
	 */
	pi.on("before_agent_start", () => {
		if (!interruptedNoteDue) return;
		interruptedNoteDue = false;
		if (interrupted.size === 0) return;
		const list = [...interrupted.values()]
			.map((r) => `- ${r.name}${r.task ? `: ${oneLine(r.task, 160)}` : ""}`)
			.join("\n");
		return {
			message: {
				customType: NOTE_TYPE,
				content:
					`[multi-agent] These workers were interrupted when the previous pi process quit. They are not running:\n${list}\n` +
					"If the user wants them continued, call worker_resume. It keeps each worker's own context, so do not " +
					"respawn them with worker_spawn.",
				display: false,
			},
		};
	});

	/** Continue interrupted workers (default: all), each in its own session. Returns one line per worker. */
	async function resumeWorkers(ctx: ExtensionContext, names?: string[]): Promise<string[]> {
		const targets = names?.length
			? names.map((n) => getWorker(n))
			: registry.list().filter((w) => w.status === "interrupted");
		const lines: string[] = [];
		for (const w of targets) {
			const rec = interrupted.get(w.name);
			if (w.status !== "interrupted" || !rec || resuming.has(w.name)) {
				lines.push(`${w.name}: not interrupted (${STATUS_LABEL[w.status]}), nothing to resume`);
				continue;
			}
			if (oldProcessAlive(rec.pid, w.name)) {
				lines.push(`${w.name}: its old process (pid ${rec.pid}) still runs; resume after it exits, or kill it first`);
				continue;
			}
			resuming.add(w.name);
			try {
				const session = rec.sessionFile && fs.existsSync(rec.sessionFile) ? rec.sessionFile : undefined;
				const repaired = session ? repairSession(session) : 0;
				const o = rec.options ?? { cwd: ctx.cwd, notify: true };
				const worker = await spawnWorker(ctx, {
					name: w.name,
					cwd: o.cwd,
					model: o.model,
					thinking: o.thinking,
					tools: o.tools,
					role: o.role,
					notify: o.notify,
					resumeSession: session,
				});
				if (session) {
					await worker.prompt(RESUME_PROMPT, "RESUME");
					const fixed = repaired ? `; ${repaired} unfinished tool call(s) marked as not run` : "";
					lines.push(`${w.name}: resumed in its own session${fixed}`);
				} else {
					await worker.prompt(`${rec.task ?? "Continue your previous task."}\n\n${INTERRUPTED_NOTE}`);
					lines.push(`${w.name}: had no session file, so it restarted its task`);
				}
			} catch (error) {
				lines.push(`${w.name}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				resuming.delete(w.name);
			}
		}
		return lines;
	}

	async function spawnWorker(
		ctx: ExtensionContext,
		params: {
			name: string;
			role?: string;
			model?: string;
			thinking?: string;
			tools?: string;
			cwd?: string;
			notify?: boolean;
			/** Resume: open this session file instead of creating a new session. */
			resumeSession?: string;
		},
	): Promise<Worker> {
		const name = sanitizeName(params.name);
		const existing = registry.workers.get(name);
		if (existing?.alive) {
			throw new Error(
				`Worker "${name}" already exists (${STATUS_LABEL[existing.status]}). Use worker_send to give it more work, or choose another name.`,
			);
		}
		const live = registry.list().filter((w) => w.alive).length;
		if (live >= MAX_LIVE_WORKERS) {
			throw new Error(
				`Too many live workers (${live}/${MAX_LIVE_WORKERS}). Kill finished workers with worker_stop first (idle ones are stopped automatically after a while).`,
			);
		}
		const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
		if (!fs.existsSync(cwd)) throw new Error(`Worker cwd does not exist: ${cwd}`);

		// Inherit the manager's model and thinking level unless a model was chosen explicitly.
		const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const thinking = params.thinking ?? (params.model ? undefined : ctx.thinkingLevel);

		if (existing) {
			existing.removeAllListeners();
			registry.workers.delete(name);
			interrupted.delete(name); // a new or resumed worker replaces the interrupted entry
		}
		const worker = new Worker(
			{
				name,
				cwd,
				runDir: getRunDir(ctx),
				model,
				thinking,
				tools: params.tools,
				role: params.role,
				extraArgs: extraWorkerArgs,
				notify: params.notify ?? true,
				sessionFile: params.resumeSession,
				sessionDir: workerSessionDir(),
			},
			host,
		);
		register(worker);
		try {
			await worker.start();
		} catch (error) {
			await worker.stop().catch(() => undefined);
			throw new Error(`Worker "${name}" failed to start: ${error instanceof Error ? error.message : String(error)}`);
		}
		return worker;
	}

	function getWorker(rawName: string): Worker {
		const name = rawName.trim();
		const worker = registry.workers.get(name) ?? registry.workers.get(sanitizeName(name));
		if (!worker) {
			const known = registry.list().map((w) => w.name);
			throw new Error(`No worker named "${name}". Known workers: ${known.length ? known.join(", ") : "(none)"}`);
		}
		return worker;
	}

	type WaitOutcome = "done" | "timeout" | "aborted" | "interrupted" | "stalled";

	/**
	 * Blocks the manager's turn. Returns early when the user queues a message, so the user can always talk to the
	 * manager while workers run, and when the health check alerts about a waited-for worker ("stalled"), so the manager
	 * follows up instead of waiting for the timeout.
	 */
	async function waitForWorkers(
		workers: Worker[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		onProgress?: (text: string) => void,
	): Promise<WaitOutcome> {
		for (const w of workers) waiting.set(w.name, (waiting.get(w.name) ?? 0) + 1);
		// Alerts so far, per worker object (a resume replaces the object; the new one starts at 0).
		const alertsBefore = new Map(workers.map((w) => [latest(w), latest(w).health.alerts]));
		const newAlert = (w: Worker) => w.health.alerts > (alertsBefore.get(w) ?? 0);
		try {
			const deadline = Date.now() + timeoutMs;
			let lastProgress = 0;
			while (true) {
				const now = workers.map(latest);
				if (now.every((w) => !working(w))) return "done";
				if (signal?.aborted) return "aborted";
				if (userMessagePending(ctx)) return "interrupted";
				if (now.some((w) => working(w) && newAlert(w))) return "stalled";
				if (Date.now() >= deadline) return "timeout";
				if (onProgress && Date.now() - lastProgress >= 1000) {
					lastProgress = Date.now();
					const running = now.filter(working).length;
					onProgress(`Waiting for ${running}/${now.length} worker(s)…\n${statusTable(now)}`);
				}
				await abortableSleep(400, signal);
			}
		} finally {
			for (const w of workers) {
				const n = (waiting.get(w.name) ?? 1) - 1;
				if (n <= 0) waiting.delete(w.name);
				else waiting.set(w.name, n);
			}
		}
	}

	function userMessagePending(ctx: ExtensionContext): boolean {
		try {
			return ctx.hasPendingMessages();
		} catch {
			return false;
		}
	}

	function buildResults(waitedFor: Worker[], outcome: WaitOutcome) {
		const workers = waitedFor.map(latest);
		const finished = workers.filter((w) => !working(w));
		const running = workers.filter(working);
		const budget = Math.max(2_000, Math.floor(RESULT_BUDGET_BYTES / Math.max(1, finished.length)));
		const parts: string[] = [];
		if (outcome === "timeout") parts.push(`Wait timed out; ${running.length} worker(s) still running.`);
		if (outcome === "aborted") parts.push("Wait cancelled; the workers keep running in the background.");
		if (outcome === "interrupted") {
			parts.push(
				"Wait stopped because the user sent a message. The workers keep running in the background. " +
					"Answer the user now; use worker_send if the message is for a worker. " +
					"Do not call worker_wait again unless the user asks; results arrive automatically.",
			);
		}
		if (outcome === "stalled") {
			const stuck = running.filter((w) => w.health.episodeAlerts > 0);
			parts.push(
				`Wait stopped early: the health check found ${stuck.length || "a"} worker(s) that may be stuck. ` +
					"They keep running. Follow up now and tell the user what you found and did. Call worker_wait again only if " +
					"you decide to keep waiting.",
				...stuck.map(healthFollowUp),
			);
		}
		for (const w of finished) {
			w.reported = true;
			parts.push(formatResultBlock(w, budget));
		}
		for (const w of running) {
			parts.push(formatRunningBlock(w));
		}
		return {
			content: [{ type: "text" as const, text: parts.join("\n\n") || "No workers." }],
			details: { outcome, workers: workers.map(snapshot) },
		};
	}

	function progressUpdater(onUpdate: ((r: any) => void) | undefined, workers: Worker[]) {
		if (!onUpdate) return undefined;
		return (text: string) =>
			onUpdate({ content: [{ type: "text", text }], details: { outcome: "running", workers: workers.map(snapshot) } });
	}

	// ------------------------------------------------------------ rendering helpers

	function renderCallFor(label: string) {
		return (args: any, theme: any) => {
			const target = args?.name ?? (Array.isArray(args?.names) ? args.names.join(", ") : "");
			const detail = args?.task ?? args?.message ?? args?.mode ?? "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", target)} ${theme.fg("dim", oneLine(String(detail), 120))}`.trim(),
				0,
				0,
			);
		};
	}

	/**
	 * Tool rows: worker blocks, status tables and results are drawn as tables and Markdown (see report.ts). Errors keep
	 * the plain red text.
	 */
	function renderResultText(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
		const text = textOf(result?.content);
		const expandHint = context?.keyHint ? context.keyHint("app.tools.expand", "to expand") : "expand to see all";
		if (!context?.isError) {
			return renderReport(text, { expanded: options.expanded, theme, markdownTheme: getMarkdownTheme(), expandHint });
		}
		const lines = text.split("\n");
		const limit = options.expanded ? lines.length : 12;
		let out = lines.slice(0, limit).join("\n");
		if (lines.length > limit) out += `\n${theme.fg("muted", `… ${lines.length - limit} more lines (${expandHint})`)}`;
		return new Text(theme.fg("error", out), 0, 0);
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as { name?: string; status?: string } | undefined;
		const ok = details?.status === "done";
		const header = theme.fg(ok ? "success" : "warning", theme.bold(`⚑ worker ${details?.name ?? "?"} ${details?.status ?? ""}`));
		// The first content line repeats the header ("Worker "x" finished (done)."); the rest is a worker block.
		const body = textOf(message.content).replace(/^Worker "[^"\n]*" finished \([^)\n]*\)\.\n+/, "");
		const view = new Container();
		view.addChild(new Text(header, options.outputPad, 0));
		view.addChild(
			renderReport(body, {
				expanded: options.expanded,
				theme,
				markdownTheme: getMarkdownTheme(),
				expandHint: options.keyHint("app.tools.expand", "to expand"),
				paddingX: options.outputPad,
			}),
		);
		return view;
	});

	pi.registerMessageRenderer(HEALTH_TYPE, (message, options, theme) => {
		const d = message.details as { name?: string; title?: string; detail?: string; repeat?: boolean } | undefined;
		const header = theme.fg(
			"warning",
			theme.bold(`⚠ worker ${d?.name ?? "?"} ${d?.repeat ? "still stuck" : "may be stuck"} (${d?.title ?? "?"})`),
		);
		// The first content line is the headline; the header shows it, the detail follows in full.
		const body = textOf(message.content).replace(/^[^\n]*\n+/, "");
		const view = new Container();
		view.addChild(new Text(header, options.outputPad, 0));
		if (d?.detail) view.addChild(new Text(theme.fg("warning", d.detail), options.outputPad, 0));
		view.addChild(
			renderReport(body, {
				expanded: options.expanded,
				theme,
				markdownTheme: getMarkdownTheme(),
				expandHint: options.keyHint("app.tools.expand", "to expand"),
				paddingX: options.outputPad,
			}),
		);
		return view;
	});

	// ------------------------------------------------------------ tools for the manager LLM

	pi.registerTool({
		name: "worker_spawn",
		label: "Spawn Worker",
		description:
			"Start a worker: a separate pi agent process with its own context window, and give it a task. " +
			"Returns immediately (unless wait=true) while the worker runs in parallel. " +
			"When the worker finishes, its result is sent to you automatically as a new message. " +
			"The worker cannot see this conversation, so the task must be self-contained.",
		promptSnippet: "Delegate a self-contained task to a parallel worker pi agent",
		promptGuidelines: [
			"Use worker_spawn to delegate independent subtasks (research, review, implementation of separate areas) to parallel worker agents; give each worker complete context, file paths, constraints and the expected output format, because workers cannot see this conversation.",
			"After starting workers with worker_spawn, end your turn: tell the user which workers run and that you will report each result. Results arrive automatically, and the user can talk to you meanwhile. Use worker_wait, or wait=true on worker_spawn/worker_send, only when the user asks you to wait. Never poll worker_status in a loop.",
			"When a worker result message arrives, report it to the user in a short summary.",
			"When a health alert says a worker may be stuck, follow up on it: check with worker_status, then leave it running, steer, abort or kill it, and tell the user briefly what you found and did.",
			"Do not let two workers started with worker_spawn edit the same files at the same time; split work by file or module.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short unique worker name, e.g. 'scout-auth' (letters, digits, - and _)." }),
			task: Type.String({
				description:
					"Complete, self-contained instructions including all needed context, relevant file paths, constraints and the expected output format.",
			}),
			role: Type.Optional(
				Type.String({
					description:
						"Optional persona and rules appended to the worker's system prompt, e.g. 'You are a read-only code reviewer. Never modify files.'",
				}),
			),
			model: Type.Optional(
				Type.String({ description: "Model pattern such as 'provider/id' or 'sonnet'. Default: the manager's model." }),
			),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level. Default: the manager's level." })),
			tools: Type.Optional(
				Type.String({
					description: "Comma-separated tool allowlist, e.g. 'read,grep,find,ls' for a read-only worker. Default: pi's default tools.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the worker. Default: the manager's cwd." })),
			wait: Type.Optional(
				Type.Boolean({
					description: "Block until the worker finishes and return its result. Default false. Only when the user asks you to wait.",
				}),
			),
			notify: Type.Optional(
				Type.Boolean({
					description: "Send you the result automatically when the worker finishes and nobody is waiting on it. Default true.",
				}),
			),
			timeoutSeconds: Type.Optional(Type.Number({ description: `Max seconds to wait when wait=true. Default ${DEFAULT_WAIT_SECONDS}.` })),
		}),
		renderCall: renderCallFor("worker_spawn"),
		renderResult: renderResultText,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			uiCtx = ctx;
			onUpdate?.({ content: [{ type: "text", text: `Starting worker ${params.name}…` }], details: undefined });
			const worker = await spawnWorker(ctx, params);
			await worker.prompt(params.task);
			if (!params.wait) {
				const notifyText = worker.config.notify
					? "The result is sent to you automatically when it finishes. Unless the user asked you to wait, do not wait: end your turn or continue other work."
					: "notify=false: call worker_wait or worker_status to get the result.";
				return {
					content: [
						{
							type: "text",
							text:
								`Started worker "${worker.name}" (pid ${worker.pid}, ${worker.model ?? "default model"}, thinking ${worker.thinkingLevel ?? "default"}).\n` +
								`Live log: ${worker.logPath}\n${notifyText}`,
						},
					],
					details: { outcome: "started", workers: [snapshot(worker)] },
				};
			}
			const timeoutMs = (params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
			const outcome = await waitForWorkers([worker], timeoutMs, signal, ctx, progressUpdater(onUpdate, [worker]));
			return buildResults([worker], outcome);
		},
	});

	pi.registerTool({
		name: "worker_send",
		label: "Message Worker",
		description:
			"Send a message to an existing worker. If the worker is idle it starts working on the message as a new task (it remembers its previous work). " +
			"If it is busy: mode 'steer' redirects it after its current step, mode 'followUp' queues the message until it finishes. " +
			"A worker stopped for being idle is started again on its own session first, so it keeps its context.",
		promptSnippet: "Steer a running worker or give an existing worker more work",
		promptGuidelines: [
			"Use worker_send to give follow-up work to an existing worker that already has relevant context, instead of spawning a new worker.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Worker name." }),
			message: Type.String({ description: "Instructions for the worker." }),
			mode: Type.Optional(
				StringEnum(["steer", "followUp"] as const, { description: "Delivery while the worker is busy. Default 'followUp'." }),
			),
			wait: Type.Optional(Type.Boolean({ description: "Block until the worker finishes and return its result. Default false." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: `Max seconds to wait when wait=true. Default ${DEFAULT_WAIT_SECONDS}.` })),
		}),
		renderCall: renderCallFor("worker_send"),
		renderResult: renderResultText,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			uiCtx = ctx;
			let worker = getWorker(params.name);
			if (worker.status === "interrupted") {
				throw new Error(
					`Worker "${worker.name}" was interrupted when pi quit; call worker_resume to continue it with its context, then send.`,
				);
			}
			let revived = "";
			if (worker.idleStoppedAfterMs !== undefined && (revivable(worker) || worker.stopping)) {
				const hadSession = !!worker.sessionFile && fs.existsSync(worker.sessionFile);
				worker = await ensureLive(ctx, worker);
				revived = hadSession
					? "It had been stopped for being idle; restarted on its own session, so it keeps its context. "
					: "It had been stopped for being idle and had no session file; restarted with a fresh context. ";
			}
			if (!worker.alive) throw new Error(`Worker "${worker.name}" is ${STATUS_LABEL[worker.status]}; spawn a new one.`);
			const mode = params.mode ?? "followUp";
			const disposition = await worker.send(params.message, mode);
			if (params.wait) {
				const timeoutMs = (params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
				const outcome = await waitForWorkers([worker], timeoutMs, signal, ctx, progressUpdater(onUpdate, [worker]));
				const res = buildResults([worker], outcome);
				if (revived) res.content[0]!.text = `${revived.trim()}\n\n${res.content[0]!.text}`;
				return res;
			}
			const what =
				revived +
				(disposition === "started"
					? `Worker "${worker.name}" started working on the message.`
					: disposition === "queued"
						? `Message queued for worker "${worker.name}" (${mode}).`
						: `The message was handled by an extension command in worker "${worker.name}".`);
			return { content: [{ type: "text", text: what }], details: { outcome: disposition, workers: [snapshot(worker)] } };
		},
	});

	pi.registerTool({
		name: "worker_wait",
		label: "Wait for Workers",
		description:
			"Block until workers finish and return their final results. Use only when the user asks you to wait; otherwise results arrive automatically. " +
			"Returns early if the user sends a message or a health check finds a waited-for worker stuck. Without names, waits for every running worker and also returns results not yet reported to you.",
		promptSnippet: "Wait for workers to finish and collect their results",
		parameters: Type.Object({
			names: Type.Optional(Type.Array(Type.String(), { description: "Workers to wait for. Default: all running or unreported workers." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: `Max seconds to wait. Default ${DEFAULT_WAIT_SECONDS}.` })),
		}),
		renderCall: renderCallFor("worker_wait"),
		renderResult: renderResultText,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			uiCtx = ctx;
			const targets = params.names?.length
				? params.names.map(getWorker)
				: registry
						.list()
						.filter((w) => working(w) || (!w.reported && w.tasks > 0 && (!w.stopping || revivable(w))));
			if (targets.length === 0) {
				const all = registry.list();
				const text = all.length
					? `No running workers and no unreported results.\n${statusTable(all)}`
					: "No workers.";
				return { content: [{ type: "text", text }], details: { outcome: "done", workers: all.map(snapshot) } };
			}
			const timeoutMs = (params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
			const outcome = await waitForWorkers(targets, timeoutMs, signal, ctx, progressUpdater(onUpdate, targets));
			return buildResults(targets, outcome);
		},
	});

	pi.registerTool({
		name: "worker_status",
		label: "Worker Status",
		description:
			"Show worker status. Without a name: a status table (one row per worker) and its legend. With a name: details, latest thinking, recent activity and the last result. " +
			"When you show worker status to the user, show the table and the legend as they are.",
		promptSnippet: "Inspect worker progress, recent activity and results",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Worker name for a detailed report." })),
		}),
		renderCall: renderCallFor("worker_status"),
		renderResult: renderResultText,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			if (params.name) {
				const worker = getWorker(params.name);
				const t = truncateHead(detailReport(worker), { maxBytes: RESULT_BUDGET_BYTES, maxLines: 2000 });
				return { content: [{ type: "text", text: t.content }], details: { workers: [snapshot(worker)] } };
			}
			const all = registry.list();
			const text = all.length
				? `${statusTable(all)}\n\nlogs: ${runDir ?? "(none yet)"}\n${describeHealthConfig(healthConfig)}\n${describeIdleConfig(idleConfig)}`
				: "No workers.";
			return { content: [{ type: "text", text }], details: { workers: all.map(snapshot) } };
		},
	});

	pi.registerTool({
		name: "worker_stop",
		label: "Stop Worker",
		description:
			"Stop a worker (or 'all'). mode 'abort' cancels its current task but keeps it alive for more work; mode 'kill' terminates the process.",
		promptSnippet: "Abort a worker's task or terminate the worker",
		parameters: Type.Object({
			name: Type.String({ description: "Worker name, or 'all'." }),
			mode: Type.Optional(StringEnum(["abort", "kill"] as const, { description: "Default 'abort'." })),
		}),
		renderCall: renderCallFor("worker_stop"),
		renderResult: renderResultText,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const mode = params.mode ?? "abort";
			const targets = params.name.trim() === "all" ? registry.list().filter((w) => w.alive) : [getWorker(params.name)];
			const lines: string[] = [];
			for (const w of targets) {
				try {
					w.reported = true;
					if (w.status === "interrupted") {
						if (mode === "kill") dismiss(w);
						lines.push(
							mode === "kill"
								? `${w.name}: dismissed (it was interrupted; it will not be offered for resume)`
								: `${w.name}: not running (interrupted); worker_resume continues it`,
						);
					} else if (mode === "kill") {
						w.idleStoppedAfterMs = undefined; // killed on purpose: not revived by worker_send
						await w.stop();
						lines.push(`${w.name}: killed`);
					} else if (w.busy) {
						await w.abort();
						lines.push(`${w.name}: task aborted; worker is idle and can take more work via worker_send`);
					} else {
						lines.push(`${w.name}: was not busy`);
					}
				} catch (error) {
					lines.push(`${w.name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return {
				content: [{ type: "text", text: lines.join("\n") || "No live workers." }],
				details: { workers: targets.map(snapshot) },
			};
		},
	});

	pi.registerTool({
		name: "worker_resume",
		label: "Resume Workers",
		description:
			"Continue workers that were interrupted when pi quit (status interrupted). Each one restarts in its own session, " +
			"keeps its context and is told to continue where it stopped. Without names: all interrupted workers. " +
			"Their results arrive automatically, like those of any worker.",
		promptSnippet: "Continue workers that were interrupted when pi quit",
		promptGuidelines: [
			"Use worker_resume, not worker_spawn, to continue workers whose status is interrupted; worker_resume keeps each worker's own context.",
		],
		parameters: Type.Object({
			names: Type.Optional(
				Type.Array(Type.String(), { description: "Workers to resume. Default: all interrupted workers." }),
			),
		}),
		renderCall: renderCallFor("worker_resume"),
		renderResult: renderResultText,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const lines = await resumeWorkers(ctx, params.names);
			const text = lines.length
				? `${lines.join("\n")}\n\nEach resumed worker's result is sent to you automatically when it finishes. ` +
					"Unless the user asked you to wait, do not wait."
				: "No interrupted workers.";
			return { content: [{ type: "text", text }], details: { outcome: "resumed", workers: registry.list().map(snapshot) } };
		},
	});

	// ------------------------------------------------------------ commands for you

	const completeWorkerNames = (prefix: string) => {
		const items = registry
			.list()
			.filter((w) => w.name.startsWith(prefix))
			.map((w) => ({ value: w.name, label: w.name, description: `${STATUS_LABEL[w.status]} · ${oneLine(w.activity, 60)}` }));
		return items.length ? items : null;
	};

	async function openViewer(ctx: ExtensionContext, initial?: string): Promise<void> {
		if (ctx.mode !== "tui") {
			const all = registry.list();
			ctx.ui.notify(statusTable(all), "info");
			return;
		}
		let current = initial;
		viewerOpen = true;
		refreshWidget();
		try {
			while (true) {
				const action = await ctx.ui.custom<ViewerAction>((tui, theme, keybindings, done) =>
					createViewer(registry, current, tui, theme, keybindings, done),
				);
				if (!action || action.action === "close") return;
				current = action.name;
				let w = registry.workers.get(action.name);
				if (!w) continue;
				try {
					if (action.action === "message") {
						w = await ensureLive(ctx, w);
						if (!w.alive) {
							ctx.ui.notify(`Worker ${w.name} is ${STATUS_LABEL[w.status]}.`, "warning");
							continue;
						}
						const text = await ctx.ui.input(
							`Message to ${w.name} (${w.busy ? "steers the current task" : "starts a new task"})`,
							"instructions…",
						);
						if (text?.trim()) await w.send(text.trim(), "steer");
					} else if (action.action === "abort") {
						if (w.busy) await w.abort();
					} else if (action.action === "kill") {
						if (w.alive && (await ctx.ui.confirm(`Kill worker ${w.name}?`, "The worker process will be terminated."))) {
							w.reported = true;
							w.idleStoppedAfterMs = undefined;
							await w.stop();
						}
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
		} finally {
			viewerOpen = false;
			refreshWidget();
		}
	}

	pi.registerCommand("workers", {
		description: "Watch workers live: thinking, output, tool calls (optionally pass a worker name)",
		getArgumentCompletions: completeWorkerNames,
		handler: async (args, ctx) => {
			uiCtx = ctx;
			await openViewer(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand("worker-send", {
		description: "Message a worker yourself: /worker-send <name> <message> (steers it if busy)",
		getArgumentCompletions: completeWorkerNames,
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) return ctx.ui.notify("Usage: /worker-send <name> <message>", "warning");
			try {
				let w = getWorker(match[1]!);
				w = await ensureLive(ctx, w);
				const disposition = await w.send(match[2]!.trim(), "steer");
				ctx.ui.notify(`${w.name}: ${disposition === "started" ? "started new task" : `message ${disposition}`}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("worker-stop", {
		description: "Abort a worker's task: /worker-stop <name|all> [kill]",
		getArgumentCompletions: completeWorkerNames,
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const [name, mode] = args.trim().split(/\s+/);
			if (!name) return ctx.ui.notify("Usage: /worker-stop <name|all> [kill]", "warning");
			try {
				const targets = name === "all" ? registry.list().filter((w) => w.alive) : [getWorker(name)];
				for (const w of targets) {
					if (w.status === "interrupted") {
						if (mode === "kill") dismiss(w);
					} else if (mode === "kill") {
						w.reported = true;
						w.idleStoppedAfterMs = undefined;
						await w.stop();
					} else await w.abort();
				}
				ctx.ui.notify(`${mode === "kill" ? "Killed" : "Aborted"}: ${targets.map((w) => w.name).join(", ") || "(none)"}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("workers-legend", {
		description: "Show the worker status table and the meaning of each column",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			const all = registry.list();
			ctx.ui.notify(all.length ? statusTable(all) : `No workers.\n\n${STATUS_LEGEND}`, "info");
		},
	});

	pi.registerCommand("workers-resume", {
		description: "Continue workers that were interrupted when pi quit: /workers-resume [name ...] (default: all)",
		getArgumentCompletions: (prefix: string) => {
			const items = [...interrupted.keys()]
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n, description: "interrupted" }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const names = args.trim().split(/\s+/).filter((n) => n && n !== "all");
			try {
				const lines = await resumeWorkers(ctx, names);
				const failed = lines.some((l) => !/: (resumed|had no session file)/.test(l));
				ctx.ui.notify(lines.length ? lines.join("\n") : "No interrupted workers.", failed ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("workers-clear", {
		description: "Remove stopped, crashed and interrupted workers from the list (interrupted ones are dismissed)",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			let removed = 0;
			for (const w of registry.list()) {
				if (w.alive) continue;
				dismiss(w);
				w.removeAllListeners();
				registry.workers.delete(w.name);
				removed++;
			}
			registry.emit("change");
			ctx.ui.notify(`Removed ${removed} worker(s). Logs stay in ${runDir ?? "(none)"}`, "info");
		},
	});

	// ------------------------------------------------------------ session lifecycle

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		shuttingDown = false;
		restoreInterrupted(ctx);
		if (!ticker) {
			// Keeps elapsed times in the widget/viewer moving while workers run.
			ticker = setInterval(() => {
				if (registry.list().some((w) => w.busy)) registry.emit("change");
			}, 1000);
			ticker.unref?.();
		}
		if (!healthTimer && healthConfig.intervalMs > 0) {
			// Follow up on running workers (health.ts). With no busy worker a tick does nothing.
			healthTimer = setInterval(() => void checkHealth().catch(() => undefined), healthConfig.intervalMs);
			healthTimer.unref?.();
		}
		if (!idleTimer && idleConfig.intervalMs > 0) {
			// Stop worker processes nobody reused for PI_MULTI_AGENT_IDLE_MINUTES (idle.ts).
			idleTimer = setInterval(() => void reapIdle().catch(() => undefined), idleConfig.intervalMs);
			idleTimer.unref?.();
		}
		refreshWidget();
	});

	pi.on("session_shutdown", async () => {
		// From here on, stopping workers is not recorded: their last record stays "busy", so they come back as
		// interrupted when this session is opened again.
		shuttingDown = true;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = undefined;
		if (idleTimer) clearInterval(idleTimer);
		idleTimer = undefined;
		if (renderTimer) clearTimeout(renderTimer);
		renderTimer = undefined;
		const workers = registry.list();
		for (const w of workers) w.reported = true;
		await Promise.allSettled(workers.map((w) => w.stop()));
		for (const w of workers) w.removeAllListeners();
		registry.workers.clear();
		try {
			if (widgetMode !== "none") uiCtx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			/* ignore */
		}
		widgetMode = "none";
		widgetTui = undefined;
		uiCtx = undefined;
		runDir = undefined;
	});
}
