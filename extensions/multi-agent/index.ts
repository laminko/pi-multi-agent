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
	formatSize,
	getAgentDir,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detailReport, oneLine, STATUS_LABEL, STATUS_LEGEND, statusTable } from "./format.ts";
import { createViewer, createWidgetComponent, type ViewerAction, widgetLines } from "./ui.ts";
import { type DialogRequest, Worker, type WorkerHost } from "./worker.ts";

const WIDGET_KEY = "multi-agent";
const MESSAGE_TYPE = "multi-agent";
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
		turns: w.turns,
		toolCalls: w.toolCalls,
		cost: w.usage.cost,
		logPath: w.logPath,
		sessionFile: w.sessionFile,
	};
}

/** Result block for the manager LLM. */
function formatResult(w: Worker, maxBytes: number): string {
	const lines = [`<worker name="${w.name}" status="${STATUS_LABEL[w.status]}">`, statusTable([w], { legend: false })];
	if ((w.status === "error" || w.status === "crashed") && w.errorMessage) lines.push(`error: ${w.errorMessage}`);
	const result = w.result ?? "(no final text output)";
	const t = truncateHead(result, { maxBytes, maxLines: 2000 });
	lines.push("<result>", t.content, "</result>");
	if (t.truncated) {
		lines.push(
			`[result truncated to ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}; full text: ${w.resultPath}]`,
		);
	}
	lines.push(`(full transcript log: ${w.logPath})`, "</worker>");
	return lines.join("\n");
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

	let uiCtx: ExtensionContext | undefined;
	let runDir: string | undefined;
	let widgetTui: { requestRender(): void } | undefined;
	let widgetMode: "none" | "component" | "lines" = "none";
	let viewerOpen = false;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

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
		const root = process.env.PI_MULTI_AGENT_DIR || path.join(getAgentDir(), "multi-agent");
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
					content: `Worker "${w.name}" finished (${status}).\n\n${formatResult(w, RESULT_BUDGET_BYTES)}`,
					display: true,
					details: { name: w.name, status },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* session gone */
		}
	}

	function register(worker: Worker): void {
		worker.on("change", () => registry.emit("change"));
		worker.on("settled", () => onSettled(worker));
		registry.workers.set(worker.name, worker);
		registry.emit("change");
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
			throw new Error(`Too many live workers (${live}/${MAX_LIVE_WORKERS}). Kill finished workers with worker_stop first.`);
		}
		const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
		if (!fs.existsSync(cwd)) throw new Error(`Worker cwd does not exist: ${cwd}`);

		// Inherit the manager's model and thinking level unless a model was chosen explicitly.
		const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const thinking = params.thinking ?? (params.model ? undefined : ctx.thinkingLevel);

		if (existing) {
			existing.removeAllListeners();
			registry.workers.delete(name);
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

	type WaitOutcome = "done" | "timeout" | "aborted" | "interrupted";

	/**
	 * Blocks the manager's turn. Returns early when the user queues a message,
	 * so the user can always talk to the manager while workers run.
	 */
	async function waitForWorkers(
		workers: Worker[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		onProgress?: (text: string) => void,
	): Promise<WaitOutcome> {
		for (const w of workers) waiting.set(w.name, (waiting.get(w.name) ?? 0) + 1);
		try {
			const deadline = Date.now() + timeoutMs;
			let lastProgress = 0;
			while (true) {
				if (workers.every((w) => !w.busy)) return "done";
				if (signal?.aborted) return "aborted";
				if (userMessagePending(ctx)) return "interrupted";
				if (Date.now() >= deadline) return "timeout";
				if (onProgress && Date.now() - lastProgress >= 1000) {
					lastProgress = Date.now();
					const running = workers.filter((w) => w.busy).length;
					onProgress(`Waiting for ${running}/${workers.length} worker(s)…\n${statusTable(workers)}`);
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

	function buildResults(workers: Worker[], outcome: WaitOutcome) {
		const finished = workers.filter((w) => !w.busy);
		const running = workers.filter((w) => w.busy);
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
		for (const w of finished) {
			w.reported = true;
			parts.push(formatResult(w, budget));
		}
		for (const w of running) {
			parts.push(`<worker name="${w.name}" status="running">\n${statusTable([w], { legend: false })}\n</worker>`);
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

	function renderResultText(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
		const text = textOf(result?.content);
		const lines = text.split("\n");
		const limit = options.expanded ? lines.length : 12;
		let out = lines.slice(0, limit).join("\n");
		if (lines.length > limit) {
			const hint = context?.keyHint ? context.keyHint("app.tools.expand", "to expand") : "expand to see all";
			out += `\n${theme.fg("muted", `… ${lines.length - limit} more lines (${hint})`)}`;
		}
		return new Text(context?.isError ? theme.fg("error", out) : out, 0, 0);
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as { name?: string; status?: string } | undefined;
		const ok = details?.status === "done";
		const header = theme.fg(ok ? "success" : "warning", theme.bold(`⚑ worker ${details?.name ?? "?"} ${details?.status ?? ""}`));
		const body = textOf(message.content).split("\n");
		const limit = options.expanded ? body.length : 8;
		let text = `${header}\n${theme.fg("dim", body.slice(0, limit).join("\n"))}`;
		if (body.length > limit) {
			text += `\n${theme.fg("muted", `… ${body.length - limit} more lines (${options.keyHint("app.tools.expand", "to expand")})`)}`;
		}
		return new Text(text, options.outputPad, 0);
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
			"If it is busy: mode 'steer' redirects it after its current step, mode 'followUp' queues the message until it finishes.",
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
			const worker = getWorker(params.name);
			if (!worker.alive) throw new Error(`Worker "${worker.name}" is ${STATUS_LABEL[worker.status]}; spawn a new one.`);
			const mode = params.mode ?? "followUp";
			const disposition = await worker.send(params.message, mode);
			if (params.wait) {
				const timeoutMs = (params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
				const outcome = await waitForWorkers([worker], timeoutMs, signal, ctx, progressUpdater(onUpdate, [worker]));
				return buildResults([worker], outcome);
			}
			const what =
				disposition === "started"
					? `Worker "${worker.name}" started working on the message.`
					: disposition === "queued"
						? `Message queued for worker "${worker.name}" (${mode}).`
						: `The message was handled by an extension command in worker "${worker.name}".`;
			return { content: [{ type: "text", text: what }], details: { outcome: disposition, workers: [snapshot(worker)] } };
		},
	});

	pi.registerTool({
		name: "worker_wait",
		label: "Wait for Workers",
		description:
			"Block until workers finish and return their final results. Use only when the user asks you to wait; otherwise results arrive automatically. " +
			"Returns early if the user sends a message. Without names, waits for every running worker and also returns results not yet reported to you.",
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
				: registry.list().filter((w) => w.busy || (!w.reported && w.tasks > 0 && !w.stopping));
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
			const text = all.length ? `${statusTable(all)}\n\nlogs: ${runDir ?? "(none yet)"}` : "No workers.";
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
					if (mode === "kill") {
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
				const w = registry.workers.get(action.name);
				if (!w) continue;
				try {
					if (action.action === "message") {
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
				const w = getWorker(match[1]!);
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
					if (mode === "kill") {
						w.reported = true;
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

	pi.registerCommand("workers-clear", {
		description: "Remove stopped/crashed workers from the list",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			let removed = 0;
			for (const w of registry.list()) {
				if (w.alive) continue;
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
		if (!ticker) {
			// Keeps elapsed times in the widget/viewer moving while workers run.
			ticker = setInterval(() => {
				if (registry.list().some((w) => w.busy)) registry.emit("change");
			}, 1000);
			ticker.unref?.();
		}
		refreshWidget();
	});

	pi.on("session_shutdown", async () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
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
