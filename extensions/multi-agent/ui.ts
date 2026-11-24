/**
 * TUI pieces: the always-visible worker widget and the /workers live viewer.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { oneLine, STATUS_ICON, STATUS_LABEL, statsText, statusCells } from "./format.ts";
import type { TranscriptEntry, Worker, WorkerStatus } from "./worker.ts";

// Loose structural types: keeps this file independent of exact pi type exports.
type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
};
type KeybindingsLike = { matches(data: string, id: string): boolean };
type TuiLike = { requestRender(force?: boolean): void };

export interface WorkerSource {
	list(): Worker[];
	on(event: "change", listener: () => void): unknown;
	off(event: "change", listener: () => void): unknown;
}

export type ViewerAction =
	| { action: "close" }
	| { action: "message"; name: string }
	| { action: "abort"; name: string }
	| { action: "kill"; name: string };

const plainTheme: ThemeLike = { fg: (_c, t) => t, bold: (t) => t, italic: (t) => t };

const STATUS_COLOR: Record<WorkerStatus, string> = {
	starting: "muted",
	running: "accent",
	idle: "success",
	error: "error",
	aborted: "warning",
	stopped: "dim",
	crashed: "error",
};

function statusBadge(w: Worker, theme: ThemeLike): string {
	return theme.fg(STATUS_COLOR[w.status], `${STATUS_ICON[w.status]} ${STATUS_LABEL[w.status]}`);
}

/** Tail of a string flattened to one line, keeping the most recent part. */
function tailLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `…${flat.slice(-(max - 1))}` : flat;
}

function preview(w: Worker, theme: ThemeLike, max: number): string {
	if (w.busy) {
		if (w.activity === "thinking" && w.thinkingTail.trim()) {
			return theme.fg("thinkingText", theme.italic(`💭 ${tailLine(w.thinkingTail, max)}`));
		}
		return theme.fg("muted", `⟳ ${oneLine(w.activity, max)}`);
	}
	if (w.status === "error" || w.status === "crashed") return theme.fg("error", oneLine(w.errorMessage ?? w.activity, max));
	if (w.result) return theme.fg("dim", `→ ${oneLine(w.result, max)}`);
	return theme.fg("dim", oneLine(w.activity, max));
}

// ------------------------------------------------------------------ widget

const MAX_WIDGET_ROWS = 8;

export function widgetLines(source: WorkerSource, width: number, theme: ThemeLike = plainTheme): string[] {
	const workers = source.list();
	if (workers.length === 0) return [];
	const running = workers.filter((w) => w.busy).length;
	const done = workers.filter((w) => w.status === "idle").length;
	const failed = workers.filter((w) => w.status === "error" || w.status === "crashed").length;
	const summary = [`${running} running`, `${done} done`];
	if (failed) summary.push(`${failed} failed`);
	const lines = [
		theme.fg("dim", "─ ") +
			theme.bold("workers") +
			theme.fg("dim", ` ${summary.join(" · ")}  ·  /workers to watch live  ·  /workers-legend`),
	];
	// Same columns as the default status table (format.ts statusTable); the last column is the live preview.
	const shown = workers.slice(0, MAX_WIDGET_ROWS);
	const headers = ["St", "Worker", "Turns", "Tools", "Ctx", "↑In", "↓Out", "Cost", "Time"];
	const rows = shown.map((w) => {
		const c = statusCells(w).slice(0, headers.length);
		if (c[1]!.length > 20) c[1] = `${c[1]!.slice(0, 19)}…`;
		return c;
	});
	const widths = headers.map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i]!))));
	const cell = (text: string, i: number) => {
		const pad = " ".repeat(Math.max(0, widths[i]! - visibleWidth(text)));
		return i >= 2 ? pad + text : text + pad;
	};
	lines.push(theme.fg("dim", ` ${headers.map(cell).join("  ")}  Now`));
	for (let k = 0; k < shown.length; k++) {
		const w = shown[k]!;
		const r = rows[k]!;
		const st = theme.fg(STATUS_COLOR[w.status], cell(r[0]!, 0));
		const name = theme.bold(cell(r[1]!, 1));
		const stats = theme.fg("dim", r.slice(2).map((t, j) => cell(t, j + 2)).join("  "));
		const head = ` ${st}  ${name}  ${stats}  `;
		const room = Math.max(10, width - visibleWidth(head));
		lines.push(truncateToWidth(head + preview(w, theme, room), width));
	}
	if (workers.length > MAX_WIDGET_ROWS) lines.push(theme.fg("dim", ` … ${workers.length - MAX_WIDGET_ROWS} more`));
	return lines.map((l) => truncateToWidth(l, width));
}

export function createWidgetComponent(source: WorkerSource, theme: ThemeLike) {
	return {
		render(width: number): string[] {
			return widgetLines(source, width, theme);
		},
		invalidate() {},
	};
}

// ------------------------------------------------------------------ viewer

type CachedLines = { len: number; width: number; lines: string[] };

function styleWrapped(text: string, width: number, prefix: string, style: (line: string) => string): string[] {
	const inner = Math.max(10, width - visibleWidth(prefix));
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const wrapped = raw.length === 0 ? [""] : wrapTextWithAnsi(raw, inner);
		for (const piece of wrapped) out.push(prefix + style(piece));
	}
	return out;
}

function renderEntry(e: TranscriptEntry, width: number, theme: ThemeLike): string[] {
	switch (e.kind) {
		case "task":
			return ["", theme.fg("accent", theme.bold("▣ TASK")), ...styleWrapped(e.text, width, "  ", (l) => l)];
		case "message":
			return ["", ...styleWrapped(e.text, width, theme.fg("accent", "✉ "), (l) => theme.fg("accent", l))];
		case "thinking":
			if (!e.text.trim()) return [theme.fg("dim", "┊ …")];
			return styleWrapped(e.text.trim(), width, theme.fg("dim", "┊ "), (l) => theme.fg("thinkingText", theme.italic(l)));
		case "text":
			if (!e.text.trim()) return [theme.fg("success", "│ ")];
			return styleWrapped(e.text.trim(), width, theme.fg("success", "│ "), (l) => l);
		case "tool": {
			const space = e.text.indexOf(" ");
			const name = space === -1 ? e.text : e.text.slice(0, space);
			const rest = space === -1 ? "" : e.text.slice(space + 1);
			return [truncateToWidth(`${theme.fg("accent", "▶ ")}${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("muted", rest)}`, width)];
		}
		case "toolResult": {
			const prefix = e.isError ? theme.fg("error", "  ✗ ") : theme.fg("success", "  ✓ ");
			const lines = styleWrapped(e.text || "(no output)", width, prefix, (l) => theme.fg(e.isError ? "error" : "dim", l));
			return lines.slice(0, 8).map((l, i) => (i === 0 ? l : `    ${l.slice(prefix.length)}`));
		}
		case "info":
			return styleWrapped(e.text, width, theme.fg("muted", "• "), (l) => theme.fg("muted", l));
		case "error":
			return styleWrapped(e.text, width, theme.fg("error", "✗ "), (l) => theme.fg("error", l));
	}
}

export function createViewer(
	source: WorkerSource,
	initialName: string | undefined,
	tui: TuiLike,
	theme: ThemeLike,
	keybindings: KeybindingsLike,
	done: (result: ViewerAction) => void,
) {
	let currentName = initialName;
	let scroll = 0; // lines scrolled up from the bottom; 0 = follow
	let bodyHeight = 20;
	let cache = new WeakMap<TranscriptEntry, CachedLines>();
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

	const onChange = () => {
		if (renderTimer || closed) return;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			if (!closed) tui.requestRender();
		}, 80);
	};
	source.on("change", onChange);

	const close = (result: ViewerAction) => {
		if (closed) return;
		closed = true;
		source.off("change", onChange);
		if (renderTimer) clearTimeout(renderTimer);
		done(result);
	};

	const current = (): Worker | undefined => {
		const workers = source.list();
		return workers.find((w) => w.name === currentName) ?? workers[0];
	};

	const entryLines = (e: TranscriptEntry, width: number): string[] => {
		const hit = cache.get(e);
		if (hit && hit.len === e.text.length && hit.width === width) return hit.lines;
		const lines = renderEntry(e, width, theme).map((l) => truncateToWidth(l, width));
		cache.set(e, { len: e.text.length, width, lines });
		return lines;
	};

	return {
		render(width: number): string[] {
			const workers = source.list();
			const w = current();
			if (!w) return [theme.fg("muted", "No workers yet. (esc to close)")];
			currentName = w.name;
			const index = workers.indexOf(w);
			const rows = process.stdout.rows || 40;
			bodyHeight = Math.max(6, rows - 10);

			const header = [
				`${theme.fg("accent", theme.bold(` ${w.name}`))}  ${statusBadge(w, theme)}  ${theme.fg("dim", `worker ${index + 1}/${workers.length}`)}`,
				theme.fg("muted", ` ${statsText(w)}${w.queued ? ` · ${w.queued} queued` : ""}`),
				theme.fg("dim", ` ${w.model ?? "?"} (${w.thinkingLevel ?? "?"}) · log: ${w.logPath}`),
				w.busy
					? theme.fg("warning", ` ⟳ ${oneLine(w.activity, 300)}`)
					: w.status === "error" || w.status === "crashed"
						? theme.fg("error", ` ${oneLine(w.errorMessage ?? w.activity, 300)}`)
						: theme.fg("dim", ` ${oneLine(w.activity, 300)}`),
			];

			// Collect transcript lines from the end until the viewport (plus scroll) is filled.
			const need = bodyHeight + scroll;
			const chunks: string[][] = [];
			let count = 0;
			let reachedStart = true;
			for (let i = w.transcript.length - 1; i >= 0; i--) {
				if (count >= need) {
					reachedStart = false;
					break;
				}
				const lines = entryLines(w.transcript[i]!, width);
				chunks.push(lines);
				count += lines.length;
			}
			const all = chunks.reverse().flat();
			if (reachedStart) scroll = Math.min(scroll, Math.max(0, all.length - bodyHeight));
			const end = all.length - scroll;
			const body = all.slice(Math.max(0, end - bodyHeight), end);
			while (body.length < bodyHeight) body.push("");

			const rule = theme.fg("dim", "─".repeat(Math.max(1, width)));
			const help = theme.fg(
				"dim",
				` ←/→ worker · ↑/↓ PgUp/PgDn scroll · End follow · m message · a abort · k kill · esc close${scroll ? `   ⏸ scrolled ${scroll}` : ""}`,
			);
			return [...header, rule, ...body, rule, help].map((l) => truncateToWidth(l, width));
		},

		handleInput(data: string): void {
			const workers = source.list();
			const w = current();
			if (keybindings.matches(data, "tui.select.cancel") || data === "q") return close({ action: "close" });
			if (!w) return;
			const index = workers.indexOf(w);
			if (matchesKey(data, "right") || matchesKey(data, "tab")) {
				currentName = workers[(index + 1) % workers.length]!.name;
				scroll = 0;
			} else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
				currentName = workers[(index - 1 + workers.length) % workers.length]!.name;
				scroll = 0;
			} else if (keybindings.matches(data, "tui.select.up")) scroll += 1;
			else if (keybindings.matches(data, "tui.select.down")) scroll = Math.max(0, scroll - 1);
			else if (keybindings.matches(data, "tui.select.pageUp")) scroll += Math.max(1, bodyHeight - 2);
			else if (keybindings.matches(data, "tui.select.pageDown")) scroll = Math.max(0, scroll - Math.max(1, bodyHeight - 2));
			else if (matchesKey(data, "end")) scroll = 0;
			else if (matchesKey(data, "home")) scroll = Number.MAX_SAFE_INTEGER / 2;
			else if (data === "m") return close({ action: "message", name: w.name });
			else if (data === "a") return close({ action: "abort", name: w.name });
			else if (data === "k") return close({ action: "kill", name: w.name });
			else return;
			tui.requestRender();
		},

		invalidate(): void {
			cache = new WeakMap();
		},

		dispose(): void {
			closed = true;
			source.off("change", onChange);
			if (renderTimer) clearTimeout(renderTimer);
		},
	};
}
