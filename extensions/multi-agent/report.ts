/**
 * Worker reports.
 *
 * formatResultBlock / formatRunningBlock produce the text the manager LLM gets for a worker: a <worker> block with
 * the status table, the result between <result> tags, and notes. That text is the LLM's contract and stays plain.
 *
 * parseReport / renderReport turn the same text into a TUI view for tool rows and auto-report messages: tables are
 * drawn as tables, the result is rendered as Markdown, and the tags disappear. Text that is not a <worker> block keeps
 * its line breaks (the legend is aligned with spaces); status tables inside it are drawn as tables too.
 */

import * as os from "node:os";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { STATUS_LABEL, statusTable } from "./format.ts";
import type { Worker } from "./worker.ts";

const BLOCK_START = /^<worker name="([^"]*)" status="([^"]*)">$/;
const BLOCK_END = "</worker>";
const RESULT_START = "<result>";
const RESULT_END = "</result>";
const TRUNCATED_NOTE = "[result truncated";
const LOG_NOTE = "(full transcript log: ";
const TABLE_RULE = /^\|(\s*:?-+:?\s*\|)+$/;

// ------------------------------------------------------------------ producer (LLM text)

/** Result block for the manager LLM. */
export function formatResultBlock(w: Worker, maxBytes: number): string {
	const lines = [`<worker name="${w.name}" status="${STATUS_LABEL[w.status]}">`, statusTable([w], { legend: false })];
	if ((w.status === "error" || w.status === "crashed") && w.errorMessage) lines.push(`error: ${w.errorMessage}`);
	const result = w.result ?? "(no final text output)";
	const t = truncateHead(result, { maxBytes, maxLines: 2000 });
	lines.push(RESULT_START, t.content, RESULT_END);
	if (t.truncated) {
		lines.push(
			`${TRUNCATED_NOTE} to ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}; full text: ${w.resultPath}]`,
		);
	}
	lines.push(`${LOG_NOTE}${w.logPath})`, BLOCK_END);
	return lines.join("\n");
}

/** Block for a worker that is still running (wait timed out or was interrupted). */
export function formatRunningBlock(w: Worker): string {
	return `<worker name="${w.name}" status="running">\n${statusTable([w], { legend: false })}\n${BLOCK_END}`;
}

// ------------------------------------------------------------------ parser

export type ReportSegment =
	| { kind: "text"; text: string }
	| { kind: "table"; text: string }
	| {
			kind: "worker";
			name: string;
			status: string;
			table: string;
			error?: string;
			/** Undefined for a running block, which has no result. */
			result?: string;
			/** Lines after </result>: the truncation note and the log path. */
			notes: string[];
	  };

/** Split report text into <worker> blocks, markdown tables and plain text. Malformed blocks stay plain text. */
export function parseReport(text: string): ReportSegment[] {
	const lines = text.split("\n");
	const segments: ReportSegment[] = [];
	let plain: string[] = [];
	const flush = () => {
		segments.push(...splitPlain(plain));
		plain = [];
	};
	for (let i = 0; i < lines.length; ) {
		const block = BLOCK_START.test(lines[i]!) ? parseBlock(lines, i) : undefined;
		if (!block) {
			plain.push(lines[i]!);
			i++;
			continue;
		}
		flush();
		segments.push(block.segment);
		i = block.next;
	}
	flush();
	return segments;
}

function parseBlock(lines: string[], start: number): { segment: ReportSegment; next: number } | undefined {
	const [, name = "", status = ""] = BLOCK_START.exec(lines[start]!) ?? [];
	let i = start + 1;
	const table: string[] = [];
	while (i < lines.length && lines[i]!.startsWith("|")) table.push(lines[i++]!);
	const errorLines: string[] = [];
	while (i < lines.length && lines[i] !== RESULT_START && lines[i] !== BLOCK_END) errorLines.push(lines[i++]!);
	let result: string | undefined;
	if (lines[i] === RESULT_START) {
		const end = findResultEnd(lines, i + 1);
		if (end === -1) return undefined;
		result = lines.slice(i + 1, end).join("\n");
		i = end + 1;
	}
	const notes: string[] = [];
	while (i < lines.length && lines[i] !== BLOCK_END) notes.push(lines[i++]!);
	if (i >= lines.length) return undefined;
	const error = errorLines.join("\n").replace(/^error: /, "").trim() || undefined;
	return { segment: { kind: "worker", name, status, table: table.join("\n"), error, result, notes }, next: i + 1 };
}

/**
 * The result ends at the </result> line that is followed by the closing notes (an optional truncation note, then the
 * log note that formatResultBlock always writes) and </worker>. So a result that itself contains these tags is still
 * cut in the right place.
 */
function findResultEnd(lines: string[], from: number): number {
	for (let j = from; j < lines.length; j++) {
		if (lines[j] !== RESULT_END) continue;
		let k = j + 1;
		if (lines[k]?.startsWith(TRUNCATED_NOTE)) k++;
		if (!lines[k]?.startsWith(LOG_NOTE)) continue;
		if (lines[k + 1] === BLOCK_END) return j;
	}
	return -1;
}

function splitPlain(lines: string[]): ReportSegment[] {
	const out: ReportSegment[] = [];
	let text: string[] = [];
	const flushText = () => {
		while (text.length && !text[0]!.trim()) text.shift();
		while (text.length && !text.at(-1)!.trim()) text.pop();
		if (text.length) out.push({ kind: "text", text: text.join("\n") });
		text = [];
	};
	for (let i = 0; i < lines.length; ) {
		if (lines[i]!.startsWith("|") && TABLE_RULE.test(lines[i + 1] ?? "")) {
			flushText();
			const rows: string[] = [];
			while (i < lines.length && lines[i]!.startsWith("|")) rows.push(lines[i++]!);
			out.push({ kind: "table", text: rows.join("\n") });
			continue;
		}
		text.push(lines[i++]!);
	}
	flushText();
	return out;
}

// ------------------------------------------------------------------ renderer (TUI)

type ThemeLike = { fg(color: string, text: string): string };

export interface ReportRenderOptions {
	expanded: boolean;
	theme: ThemeLike;
	markdownTheme: MarkdownTheme;
	/** Formatted expand key hint, e.g. "ctrl+o to expand". */
	expandHint: string;
	/** Horizontal padding of every line (message renderers use the outputPad setting; tool rows use 0). */
	paddingX?: number;
	/** Collapsed view: max rendered lines of each result. Default 6. */
	resultLines?: number;
	/** Collapsed view: max rendered lines of each plain text part. Default 14. */
	textLines?: number;
}

/** Shows the first `max` lines of a component, then a "… N more lines" hint. */
class Clamp implements Component {
	// Plain fields, not constructor parameter properties: Node's type stripping (used by scripts/test-*.ts) rejects those.
	private readonly inner: Component;
	private readonly max: number;
	private readonly more: (hidden: number) => string;
	private cache?: { source: string[]; width: number; lines: string[] };
	constructor(inner: Component, max: number, more: (hidden: number) => string) {
		this.inner = inner;
		this.max = max;
		this.more = more;
	}
	render(width: number): string[] {
		const source = this.inner.render(width);
		if (source.length <= this.max) return source;
		if (this.cache?.source === source && this.cache.width === width) return this.cache.lines;
		const lines = [...source.slice(0, this.max), truncateToWidth(this.more(source.length - this.max), width)];
		this.cache = { source, width, lines };
		return lines;
	}
	invalidate(): void {
		this.cache = undefined;
		this.inner.invalidate();
	}
}

const home = os.homedir();
const tidyPath = (text: string) => (home && home !== "/" ? text.split(home).join("~") : text);

function tidyNote(note: string): string {
	if (note.startsWith(LOG_NOTE) && note.endsWith(")")) return `log: ${tidyPath(note.slice(LOG_NOTE.length, -1))}`;
	return tidyPath(note);
}

/** Pi resets styles at the end of each line, so style every line separately. */
const styleLines = (theme: ThemeLike, color: string, text: string) =>
	text
		.split("\n")
		.map((l) => theme.fg(color, l))
		.join("\n");

export function renderReport(text: string, opts: ReportRenderOptions): Component {
	const { theme, markdownTheme: md } = opts;
	const pad = opts.paddingX ?? 0;
	const resultMax = opts.expanded ? Number.POSITIVE_INFINITY : (opts.resultLines ?? 6);
	const textMax = opts.expanded ? Number.POSITIVE_INFINITY : (opts.textLines ?? 14);
	const more = (hidden: number) =>
		`${" ".repeat(pad)}${theme.fg("muted", `… ${hidden} more line${hidden === 1 ? "" : "s"} (${opts.expandHint})`)}`;

	const container = new Container();
	parseReport(text).forEach((seg, index) => {
		if (index > 0) container.addChild(new Spacer(1));
		if (seg.kind === "text") {
			container.addChild(new Clamp(new Text(seg.text, pad, 0), textMax, more));
		} else if (seg.kind === "table") {
			container.addChild(new Markdown(seg.text, pad, 0, md));
		} else {
			if (seg.table) container.addChild(new Markdown(seg.table, pad, 0, md));
			if (seg.error) {
				container.addChild(new Clamp(new Text(styleLines(theme, "error", `error: ${seg.error}`), pad, 0), textMax, more));
			}
			if (seg.result !== undefined) {
				const result = seg.result.trim() || "_(no final text output)_";
				container.addChild(new Spacer(1));
				container.addChild(new Clamp(new Markdown(result, pad, 0, md), resultMax, more));
			}
			if (seg.notes.length) {
				container.addChild(new Text(styleLines(theme, "dim", seg.notes.map(tidyNote).join("\n")), pad, 0));
			}
		}
	});
	return container;
}
