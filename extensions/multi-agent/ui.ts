/**
 * TUI pieces: the always-visible worker widget and the /workers live viewer.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	CONTEXT_WARN_PERCENT,
	contextPercent,
	healthNote,
	INTERRUPTED_HINT,
	oneLine,
	STATUS_ICON,
	STATUS_LABEL,
	statsText,
	statusCells,
} from "./format.ts";
import type { TranscriptEntry, Worker, WorkerStatus } from "./worker.ts";

// Loose structural types: keeps this file independent of exact pi type exports.
type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
};
type KeybindingsLike = { matches(data: string, id: string): boolean };
/** Subset of pi-tui's TuiMouseEvent. Coordinates are zero-based and local to the component. */
type MouseEventLike = { type: string; button: string; x: number; y: number; wheelDelta?: number };
type MouseResult = { handled?: boolean; render?: boolean } | undefined;

const isLeftClick = (e: MouseEventLike) => e.type === "click" && e.button === "left";

/** A clickable span on one rendered line: columns [x0, x1). */
type HitSpan<T> = { x0: number; x1: number; value: T };
const hit = <T>(spans: HitSpan<T>[], x: number): T | undefined => spans.find((s) => x >= s.x0 && x < s.x1)?.value;
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
	interrupted: "warning",
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
		// Health check warning first (see health.ts), then what the worker does.
		const note = healthNote(w);
		const warn = note ? theme.fg("warning", `${note} `) : "";
		const room = Math.max(10, max - (note ? visibleWidth(note) + 1 : 0));
		if (w.activity === "thinking" && w.thinkingTail.trim()) {
			return warn + theme.fg("thinkingText", theme.italic(`💭 ${tailLine(w.thinkingTail, room)}`));
		}
		return warn + theme.fg("muted", `⟳ ${oneLine(w.activity, room)}`);
	}
	if (w.status === "error" || w.status === "crashed") return theme.fg("error", oneLine(w.errorMessage ?? w.activity, max));
	if (w.status === "interrupted") return theme.fg("warning", `↯ ${oneLine(INTERRUPTED_HINT, max - 2)}`);
	if (w.status === "stopped" && w.idleStoppedAfterMs !== undefined) {
		// Idle cleanup (idle.ts): say so first, so it is not mistaken for a killed worker; then the result.
		const tag = "idle · worker_send revives";
		return theme.fg("dim", w.result ? `${tag} · → ${oneLine(w.result, Math.max(10, max - tag.length - 5))}` : oneLine(tag, max));
	}
	if (w.result) return theme.fg("dim", `→ ${oneLine(w.result, max)}`);
	return theme.fg("dim", oneLine(w.activity, max));
}

// ------------------------------------------------------------------ widget

/** Max worker rows in the widget; the rest fold into one "… N more" line. */
const MAX_WIDGET_ROWS = Math.max(1, Math.floor(Number(process.env.PI_MULTI_AGENT_WIDGET_ROWS)) || 8);
/** Widget line layout: 0 = summary, 1 = column header, 2.. = one row per shown worker, then the "more" line. */
const WIDGET_FIRST_ROW = 2;

/** Widget groups: 0 running, 1 needs attention, 2 finished, 3 stopped. */
function widgetRank(w: Worker): number {
	if (w.busy || w.status === "starting" || w.status === "running") return 0;
	if (w.status === "error" || w.status === "crashed" || w.status === "interrupted") return 1;
	if (w.status === "stopped") return 3;
	return 2; // idle (done), aborted
}

/**
 * Widget row order: running workers first, in spawn order, so their rows stay put while they work. Then errors and
 * crashes, then finished workers, then stopped ones; within those groups the most recently active worker comes first.
 * With more workers than rows, the active ones therefore stay visible.
 */
export function widgetOrder(workers: Worker[]): Worker[] {
	return workers
		.map((w, i) => ({ w, i, rank: widgetRank(w), last: w.taskFinishedAt ?? w.createdAt }))
		.sort((a, b) => a.rank - b.rank || (a.rank === 0 ? 0 : b.last - a.last) || a.i - b.i)
		.map((x) => x.w);
}

interface WidgetLayout {
	lines: string[];
	/** Workers that have a row, top to bottom. */
	shown: Worker[];
	/** Workers folded into the "… N more" line. */
	hidden: Worker[];
}

export function widgetLines(source: WorkerSource, width: number, theme: ThemeLike = plainTheme): string[] {
	return widgetLayout(source, width, theme).lines;
}

function widgetLayout(source: WorkerSource, width: number, theme: ThemeLike): WidgetLayout {
	const workers = source.list();
	if (workers.length === 0) return { lines: [], shown: [], hidden: [] };
	const running = workers.filter((w) => w.busy).length;
	const done = workers.filter((w) => w.status === "idle").length;
	const failed = workers.filter((w) => w.status === "error" || w.status === "crashed").length;
	const interrupted = workers.filter((w) => w.status === "interrupted").length;
	const stuck = workers.filter((w) => healthNote(w)).length;
	const idleStopped = workers.filter((w) => w.status === "stopped" && w.idleStoppedAfterMs !== undefined).length;
	const summary = [`${running} running`, `${done} done`];
	if (stuck) summary.push(theme.fg("warning", `${stuck} may be stuck`));
	if (failed) summary.push(`${failed} failed`);
	if (interrupted) summary.push(theme.fg("warning", `${interrupted} interrupted (/workers-resume)`));
	if (idleStopped) summary.push(`${idleStopped} stopped while idle`);
	const lines = [
		theme.fg("dim", "─ ") +
			theme.bold("workers") +
			theme.fg("dim", ` ${summary.join(" · ")}  ·  /workers to watch live  ·  /workers-legend`),
	];
	// Same columns as the default status table (format.ts statusTable); the last column is the live preview.
	const ordered = widgetOrder(workers);
	const shown = ordered.slice(0, MAX_WIDGET_ROWS);
	const hidden = ordered.slice(MAX_WIDGET_ROWS);
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
		// Ctx (column 4) turns to the warning color when the context window is nearly full.
		const full = (contextPercent(w) ?? 0) >= CONTEXT_WARN_PERCENT;
		const stats = r
			.slice(2)
			.map((t, j) => theme.fg(full && j + 2 === 4 ? "warning" : "dim", cell(t, j + 2)))
			.join(theme.fg("dim", "  "));
		const head = ` ${st}  ${name}  ${stats}  `;
		const room = Math.max(10, width - visibleWidth(head));
		lines.push(truncateToWidth(head + preview(w, theme, room), width));
	}
	if (hidden.length > 0) {
		const counts = new Map<string, number>();
		for (const w of hidden) counts.set(STATUS_LABEL[w.status], (counts.get(STATUS_LABEL[w.status]) ?? 0) + 1);
		const breakdown = [...counts].map(([label, n]) => `${n} ${label}`).join(", ");
		lines.push(theme.fg("dim", ` … ${hidden.length} more (${breakdown})  ·  /workers to see all`));
	}
	return { lines: lines.map((l) => truncateToWidth(l, width)), shown, hidden };
}

/**
 * Widget component. In fullscreen mode a left click opens the viewer:
 * on a worker row, on that worker; on the "… N more" line, on the first hidden worker; on the summary or column
 * header, on the first worker. Clicks map to the rows of the last render, so a reorder cannot misdirect them.
 */
export function createWidgetComponent(source: WorkerSource, theme: ThemeLike, onOpen?: (name?: string) => void) {
	let last: WidgetLayout = { lines: [], shown: [], hidden: [] };
	return {
		render(width: number): string[] {
			last = widgetLayout(source, width, theme);
			return last.lines;
		},
		handleMouse(event: MouseEventLike): MouseResult {
			if (!onOpen || !isLeftClick(event)) return undefined;
			const row = event.y - WIDGET_FIRST_ROW;
			const target =
				row >= 0 && row < last.shown.length ? last.shown[row] : row === last.shown.length ? last.hidden[0] : undefined;
			onOpen(target?.name);
			return { handled: true, render: false };
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
	// Clickable spans from the last render: the tab bar (line 0) and the help line (last line).
	let tabSpans: HitSpan<string>[] = [];
	let helpSpans: HitSpan<"message" | "abort" | "kill" | "close" | "follow">[] = [];
	/** Index of the first visible tab when the tabs do not all fit. */
	let tabStart = 0;
	let lineCount = 0;

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

			// Tab bar: one clickable tab per worker; the current one shows its status label. When the tabs do not fit,
			// a window of them is shown that always contains the current tab, with "‹ N" / "N ›" markers counting
			// the hidden tabs on each side. The window only moves when the current tab would leave it.
			const n = workers.length;
			const tabs = workers.map((t) => {
				const label = t === w ? ` ${t.name} ` : ` ${STATUS_ICON[t.status]} ${t.name} `;
				const styled =
					t === w
						? `${theme.fg("accent", theme.bold(`[${label}]`))} ${statusBadge(t, theme)}`
						: theme.fg(STATUS_COLOR[t.status], ` ${label} `);
				return { name: t.name, styled, width: visibleWidth(styled) };
			});
			const counter = theme.fg("dim", ` worker ${index + 1}/${n}`);
			const room = width - 1 - visibleWidth(counter);
			const leftMarker = (hiddenCount: number) => `‹ ${hiddenCount} `;
			const rightMarker = (hiddenCount: number) => ` ${hiddenCount} ›`;
			/** Whether tabs lo..hi (inclusive), each followed by a space, fit together with the markers they need. */
			const fits = (lo: number, hi: number) => {
				let total = 0;
				for (let i = lo; i <= hi; i++) total += tabs[i]!.width + 1;
				if (lo > 0) total += visibleWidth(leftMarker(lo)) + 1;
				if (hi < n - 1) total += visibleWidth(rightMarker(n - 1 - hi)) + 1;
				return total <= room;
			};
			const lastFrom = (start: number) => {
				let hi = start;
				while (hi + 1 < n && fits(start, hi + 1)) hi++;
				return hi;
			};
			tabStart = Math.max(0, Math.min(tabStart, index));
			let tabEnd = lastFrom(tabStart);
			while (tabEnd < index) tabEnd = lastFrom(++tabStart);
			while (tabStart > 0 && fits(tabStart - 1, tabEnd)) tabStart--; // use free room on the right

			tabSpans = [];
			let tabBar = " ";
			let x = 1;
			const place = (styled: string, value: string) => {
				const wd = visibleWidth(styled);
				tabSpans.push({ x0: x, x1: x + wd, value });
				tabBar += `${styled} `;
				x += wd + 1;
			};
			// A marker click switches to the nearest hidden worker on that side.
			if (tabStart > 0) place(theme.fg("muted", leftMarker(tabStart)), workers[tabStart - 1]!.name);
			for (let i = tabStart; i <= tabEnd; i++) place(tabs[i]!.styled, tabs[i]!.name);
			if (tabEnd < n - 1) place(theme.fg("muted", rightMarker(n - 1 - tabEnd)), workers[tabEnd + 1]!.name);
			tabBar += counter;

			const header = [
				tabBar,
				theme.fg("muted", ` ${statsText(w)}${w.queued ? ` · ${w.queued} queued` : ""}`),
				theme.fg("dim", ` ${w.model ?? "?"} (${w.thinkingLevel ?? "?"}) · log: ${w.logPath}`),
				w.busy
					? theme.fg("warning", ` ⟳ ${oneLine(healthNote(w) ? `${healthNote(w)} · ${w.activity}` : w.activity, 300)}`)
					: w.status === "error" || w.status === "crashed"
						? theme.fg("error", ` ${oneLine(w.errorMessage ?? w.activity, 300)}`)
						: w.status === "interrupted"
							? theme.fg("warning", ` ↯ ${INTERRUPTED_HINT}`)
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
			// Help line: the action items are clickable.
			helpSpans = [];
			let help = theme.fg("dim", " ←/→ or click tab · ↑/↓ PgUp/PgDn wheel scroll · ");
			const actions: [string, (typeof helpSpans)[number]["value"]][] = [
				["End follow", "follow"],
				["m message", "message"],
				["a abort", "abort"],
				["k kill", "kill"],
				["esc close", "close"],
			];
			for (const [i, [text, value]] of actions.entries()) {
				const x0 = visibleWidth(help);
				help += theme.fg("muted", text);
				helpSpans.push({ x0, x1: x0 + text.length, value });
				if (i < actions.length - 1) help += theme.fg("dim", " · ");
			}
			if (scroll) help += theme.fg("dim", `   ⏸ scrolled ${scroll}`);
			const out = [...header, rule, ...body, rule, help].map((l) => truncateToWidth(l, width));
			lineCount = out.length;
			return out;
		},

		/** Fullscreen mode only: click a tab to switch, click an action, wheel to scroll. */
		handleMouse(event: MouseEventLike): MouseResult {
			const w = current();
			if (!w) return undefined;
			if (event.type === "wheel" && event.wheelDelta) {
				scroll = event.wheelDelta < 0 ? scroll - event.wheelDelta : Math.max(0, scroll - event.wheelDelta);
				tui.requestRender();
				return { handled: true };
			}
			if (!isLeftClick(event)) return undefined;
			if (event.y === 0) {
				const name = hit(tabSpans, event.x);
				if (name && name !== currentName) {
					currentName = name;
					scroll = 0;
					tui.requestRender();
				}
				return { handled: true };
			}
			if (event.y === lineCount - 1) {
				const action = hit(helpSpans, event.x);
				if (action === "follow") {
					scroll = 0;
					tui.requestRender();
				} else if (action === "close") close({ action: "close" });
				else if (action) close({ action, name: w.name });
				return { handled: true };
			}
			return undefined;
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
