/**
 * Checks for worker reports: the LLM text (formatResultBlock / formatRunningBlock) parses back exactly, and the TUI
 * view (renderReport) draws tables and Markdown without the <worker> / <result> tags. No model calls.
 *
 *   node scripts/test-render-report.ts [-v]      # -v prints the rendered views
 *
 * Needs Node >= 22.18. pi's own packages are found through the `pi` on PATH (see scripts/lib/pi-packages.ts).
 */
import { extensionModule } from "./lib/pi-packages.ts";

const { Worker } = await import(extensionModule("worker.ts"));
const { statusTable, STATUS_LEGEND } = await import(extensionModule("format.ts"));
const { formatResultBlock, formatRunningBlock, parseReport, renderReport } = await import(extensionModule("report.ts"));
const { visibleWidth } = await import("@earendil-works/pi-tui");

const verbose = process.argv.includes("-v");
const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t };
const id = (t: string) => t;
const markdownTheme = {
	heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id, quoteBorder: id,
	hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id,
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");

function fakeWorker(name: string, status: string, result?: string, errorMessage?: string) {
	const w = new Worker(
		{ name, cwd: "/tmp", runDir: "/tmp/pi-ma-test-report", notify: false },
		{ dialog: async () => ({ cancelled: true }), notify() {} },
	);
	w.status = status;
	w.busy = status === "running";
	w.turns = 8;
	w.toolCalls = 8;
	w.usage = { input: 16, output: 5900, cacheRead: 0, cacheWrite: 0, cost: 0.35, contextTokens: 29000 };
	w.taskStartedAt = Date.now() - 57_000;
	if (!w.busy) w.taskFinishedAt = Date.now();
	w.result = result;
	w.errorMessage = errorMessage;
	if (w.busy) w.activity = "bash $ npm test";
	return w;
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}
function view(text: string, expanded: boolean, width = 100): string[] {
	return renderReport(text, { expanded, theme: plain, markdownTheme, expandHint: "ctrl+o to expand" })
		.render(width)
		.map(stripAnsi);
}
const show = (title: string, lines: string[]) => {
	if (!verbose) return;
	console.log(`  --- ${title}`);
	for (const l of lines) console.log(`  ${l}|`);
};
const TAGS = /<\/?worker\b|<\/?result>/;

// ------------------------------------------------------------ parse round trip

const longResult = [
	"## Lesson plan: backend basics",
	"",
	"The worker reviewed **8 files** and found these issues:",
	"",
	...Array.from({ length: 12 }, (_, i) => `${i + 1}. Issue number ${i + 1} in \`src/api/file${i}.ts\``),
	"",
	"```ts",
	"const x = 1;",
	"```",
].join("\n");
const done = fakeWorker("be-lesson", "idle", longResult);
const doneText = formatResultBlock(done, 40_000);
{
	const segs = parseReport(doneText);
	const s = segs[0];
	check("parse: one worker segment", segs.length === 1 && s?.kind === "worker", JSON.stringify(segs.map((x: any) => x.kind)));
	check("parse: name and status", s?.name === "be-lesson" && s?.status === "done");
	check("parse: table is the 3-line status table", s?.table === statusTable([done], { legend: false }));
	check("parse: result is exactly the worker's result", s?.result === longResult);
	check("parse: log note kept", s?.notes.length === 1 && s.notes[0].startsWith("(full transcript log: "));
}

// A result that itself contains the closing tags.
{
	const tricky = "line one\n</result>\n</worker>\n</result>\n(full transcript log: fake)\nstill the result";
	const s = parseReport(formatResultBlock(fakeWorker("t", "idle", tricky), 40_000))[0];
	check("parse: result containing </result> and </worker> lines", s?.kind === "worker" && s.result === tricky, JSON.stringify(s));
}

// Truncated result.
{
	const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
	const s = parseReport(formatResultBlock(fakeWorker("big", "idle", big), 2_000))[0];
	check(
		"parse: truncated result has the truncation note and the log note",
		s?.kind === "worker" && s.notes.length === 2 && s.notes[0].startsWith("[result truncated") && big.startsWith(s.result),
		JSON.stringify(s?.notes),
	);
}

// Crashed worker with a multi-line error, and no result.
{
	const w = fakeWorker("boom", "crashed", undefined, "pi exited (code 1). stderr: line A\nline B");
	const s = parseReport(formatResultBlock(w, 40_000))[0];
	check(
		"parse: multi-line error and the no-output placeholder",
		s?.kind === "worker" && s.error === "pi exited (code 1). stderr: line A\nline B" && s.result === "(no final text output)",
		JSON.stringify(s),
	);
}

// worker_wait output: an explanation, a finished worker, a running worker.
const running = fakeWorker("be-test", "running");
const waitText = [
	"Wait stopped because the user sent a message. The workers keep running in the background.",
	doneText,
	formatRunningBlock(running),
].join("\n\n");
{
	const kinds = parseReport(waitText).map((x: any) => (x.kind === "worker" ? `worker:${x.status}` : x.kind));
	check("parse: wait output = text, worker:done, worker:running", kinds.join(",") === "text,worker:done,worker:running", kinds.join(","));
}

// worker_status output: a table, the legend (aligned with spaces), a log line.
const statusText = `${statusTable([done, running])}\n\nlogs: /tmp/run`;
{
	const segs = parseReport(statusText);
	const kinds = segs.map((x: any) => x.kind).join(",");
	check("parse: status output = table, text", kinds === "table,text", kinds);
	check("parse: legend text kept exactly", segs[1]?.text === `${STATUS_LEGEND}\n\nlogs: /tmp/run`);
}

// Malformed block (no </worker>): nothing is lost, it stays text.
{
	const broken = '<worker name="x" status="done">\n<result>\nhalf';
	const segs = parseReport(broken);
	check("parse: malformed block stays plain text", segs.length === 1 && segs[0].kind === "text" && segs[0].text === broken);
}

// ------------------------------------------------------------ render

{
	const collapsed = view(doneText, false);
	const expanded = view(doneText, true);
	show("auto-report body, collapsed", collapsed);
	show("auto-report body, expanded", expanded);
	check("render: no <worker>/<result> tags", !collapsed.some((l) => TAGS.test(l)) && !expanded.some((l) => TAGS.test(l)));
	check("render: no raw markdown table rule", !collapsed.some((l) => /^\s*\|[-:|]+\|\s*$/.test(l)));
	const rowLine = collapsed.find((l) => l.includes("be-lesson"));
	check("render: table row drawn with the stats", !!rowLine && /29k/.test(rowLine) && /\$0\.35/.test(rowLine), rowLine);
	check("render: Markdown applied to the result (no ## or **)", !expanded.some((l) => /^\s*## |\*\*8 files\*\*/.test(l)));
	check("render: collapsed result is clamped with a hint", collapsed.some((l) => /… \d+ more lines \(ctrl\+o to expand\)/.test(l)));
	check("render: expanded shows the whole result", expanded.some((l) => l.includes("Issue number 12")) && !expanded.some((l) => l.includes("more lines")));
	check("render: log path shortened to ~", collapsed.some((l) => /^\s*log: /.test(l)));
	check("render: every line fits width 100", [...collapsed, ...expanded].every((l) => visibleWidth(l) <= 100));
}
{
	const lines = view(waitText, false);
	show("worker_wait result, collapsed", lines);
	check(
		"render: wait output shows the note, both workers, no tags",
		lines[0]!.startsWith("Wait stopped") && lines.some((l) => l.includes("be-test")) && !lines.some((l) => TAGS.test(l)),
	);
}
{
	const lines = view(statusText, true);
	show("worker_status, expanded", lines);
	const legendLine = lines.find((l) => l.includes("model calls"))?.trimEnd(); // Text pads lines to the width
	check("render: legend keeps its alignment", legendLine === "  Turns   model calls (one per turn_start)", JSON.stringify(legendLine));
}
{
	const w = fakeWorker("boom", "crashed", undefined, "pi exited (code 1). stderr: line A\nline B");
	const lines = view(formatResultBlock(w, 40_000), false);
	show("crashed worker, collapsed", lines);
	check("render: error lines shown", lines.some((l) => l.includes("error: pi exited")) && lines.some((l) => l.includes("line B")));
}
{
	const lines = view(doneText, false, 50);
	check("render: narrow width 50 fits", lines.every((l) => visibleWidth(l) <= 50), lines.find((l) => visibleWidth(l) > 50));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
