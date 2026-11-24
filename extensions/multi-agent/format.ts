import type { Worker, WorkerStatus } from "./worker.ts";

export function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtCost(cost: number): string {
	return cost >= 0.01 || cost === 0 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

export const STATUS_ICON: Record<WorkerStatus, string> = {
	starting: "◌",
	running: "●",
	idle: "✓",
	error: "✗",
	aborted: "■",
	stopped: "○",
	crashed: "✗",
};

export const STATUS_LABEL: Record<WorkerStatus, string> = {
	starting: "starting",
	running: "running",
	idle: "done",
	error: "error",
	aborted: "aborted",
	stopped: "stopped",
	crashed: "crashed",
};

export function statsText(w: Worker): string {
	const parts = [
		`${w.turns} turns`,
		`${w.toolCalls} tools${w.toolErrors ? ` (${w.toolErrors} failed)` : ""}`,
		`ctx ${fmtTokens(w.usage.contextTokens)}`,
		`↑${fmtTokens(w.usage.input)} ↓${fmtTokens(w.usage.output)}`,
		fmtCost(w.usage.cost),
	];
	if (w.taskStartedAt) parts.push(fmtDuration(w.elapsedMs));
	return parts.join(" · ");
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Plain one-line status for the manager LLM. */
export function statusLine(w: Worker): string {
	const queued = w.queued ? ` · ${w.queued} queued` : "";
	let line = `${STATUS_ICON[w.status]} ${w.name} [${STATUS_LABEL[w.status]}] ${statsText(w)}${queued}`;
	if (w.busy) line += ` — ${oneLine(w.activity, 140)}`;
	else if (w.status === "error" || w.status === "crashed") line += ` — ${oneLine(w.errorMessage ?? w.activity, 200)}`;
	return line;
}

/**
 * Legend for statusTable. Counters (turns, tools, in, out, cost) add up over the worker's whole life;
 * time is the current task only.
 */
export const STATUS_LEGEND = [
	"Legend:",
	"  St      ● running · ✓ done · ◌ starting · ■ aborted · ✗ error/crashed · ○ stopped",
	"  Turns   model calls (one per turn_start)",
	"  Tools   tool calls; (n✗) = n returned an error",
	"  Ctx     context size now = total tokens of the last model call",
	"  ↑In     input tokens not served from cache",
	"  ↓Out    output tokens, thinking included",
	"  Cost    USD",
	"  Time    time used by the current task",
	"  Now     current activity while busy; error text when failed; widget: → result preview when done",
	"  Turns, Tools, ↑In, ↓Out and Cost add up over the worker's whole life, not per task.",
].join("\n");

const TABLE_HEADERS = ["St", "Worker", "Turns", "Tools", "Ctx", "↑In", "↓Out", "Cost", "Time", "Now"] as const;
const RIGHT_ALIGNED = new Set([2, 3, 4, 5, 6, 7, 8]);

function nowText(w: Worker, max: number): string {
	if (w.busy) return oneLine(w.activity, max);
	if (w.status === "error" || w.status === "crashed") return oneLine(w.errorMessage ?? w.activity, max);
	return "";
}

/** One row of cells for statusTable. */
export function statusCells(w: Worker, nowMax = 60): string[] {
	return [
		STATUS_ICON[w.status],
		w.queued ? `${w.name} (+${w.queued} queued)` : w.name,
		String(w.turns),
		w.toolErrors ? `${w.toolCalls} (${w.toolErrors}✗)` : String(w.toolCalls),
		fmtTokens(w.usage.contextTokens),
		fmtTokens(w.usage.input),
		fmtTokens(w.usage.output),
		fmtCost(w.usage.cost),
		w.taskStartedAt ? fmtDuration(w.elapsedMs) : "-",
		nowText(w, nowMax),
	];
}

/**
 * Default status format: an aligned table (valid markdown) plus the legend.
 * Used by worker_status, worker_wait progress, and /workers without a TUI.
 */
export function statusTable(workers: Worker[], opts: { legend?: boolean } = {}): string {
	if (workers.length === 0) return "No workers.";
	const rows = workers.map((w) => statusCells(w));
	const widths = TABLE_HEADERS.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
	const fmt = (cells: readonly string[]) =>
		`| ${cells.map((c, i) => (RIGHT_ALIGNED.has(i) ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join(" | ")} |`;
	const rule = `|${widths.map((n, i) => (RIGHT_ALIGNED.has(i) ? `${"-".repeat(n + 1)}:` : "-".repeat(n + 2))).join("|")}|`;
	const lines = [fmt(TABLE_HEADERS), rule, ...rows.map(fmt)];
	if (opts.legend !== false) lines.push("", STATUS_LEGEND);
	return lines.join("\n");
}

/** Detailed plain-text report for one worker (worker_status with a name). */
export function detailReport(w: Worker, recentEntries = 15): string {
	const lines = [
		statusTable([w]),
		"",
		`model: ${w.model ?? "?"} · thinking: ${w.thinkingLevel ?? "?"} · tasks: ${w.tasks} · pid: ${w.pid ?? "?"}`,
		`session: ${w.sessionFile ?? "(none)"}`,
		`log: ${w.logPath}`,
	];
	if (w.busy && w.thinkingTail.trim()) lines.push("", `latest thinking: …${oneLine(w.thinkingTail, 400)}`);
	const recent = w.transcript.slice(-recentEntries);
	if (recent.length) {
		lines.push("", "recent activity:");
		for (const e of recent) {
			const text = oneLine(e.text, 240);
			if (!text) continue;
			const tag = e.kind === "toolResult" ? (e.isError ? "tool✗" : "tool✓") : e.kind;
			lines.push(`- [${tag}] ${text}`);
		}
	}
	if (!w.busy && w.result) lines.push("", "result:", w.result);
	return lines.join("\n");
}
