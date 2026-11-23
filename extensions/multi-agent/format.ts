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

/** Detailed plain-text report for one worker (worker_status with a name). */
export function detailReport(w: Worker, recentEntries = 15): string {
	const lines = [
		statusLine(w),
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
