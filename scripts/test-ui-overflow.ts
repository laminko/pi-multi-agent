/**
 * UI checks with many workers: widget row order and "… N more" line, widget clicks, and the viewer tab bar window.
 * No model calls, no processes; the workers are fakes.
 *
 *   node scripts/test-ui-overflow.ts [-v]      # -v prints the rendered lines
 *
 * Needs Node >= 22.18. pi's own packages are found through the `pi` on PATH (see scripts/lib/pi-packages.ts).
 */
import { EventEmitter } from "node:events";
import { extensionModule } from "./lib/pi-packages.ts";

const { Worker } = await import(extensionModule("worker.ts"));
const ui = await import(extensionModule("ui.ts"));
const { visibleWidth } = await import("@earendil-works/pi-tui");

// ------------------------------------------------------------ fakes

const verbose = process.argv.includes("-v");
const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t };
const noKeys = { matches: () => false };
const RIGHT = "\x1b[C";
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

type Kind = "done" | "running" | "crashed" | "stopped";
function fakeSource(kinds: Kind[], name = (i: number) => `worker-${i}`) {
	const now = Date.now();
	const workers = kinds.map((kind, k) => {
		const i = k + 1;
		const w = new Worker(
			{ name: name(i), cwd: "/tmp", runDir: "/tmp/pi-ma-test-ui", notify: false },
			{ dialog: async () => ({ cancelled: true }), notify() {} },
		);
		w.createdAt = now - 100_000 + i;
		w.taskStartedAt = now - 60_000;
		w.turns = i;
		if (kind === "running") {
			w.status = "running";
			w.busy = true;
			w.activity = `bash $ npm test -- part ${i}`;
		} else {
			w.status = kind === "done" ? "idle" : kind;
			w.taskFinishedAt = now - 50_000 + i * 1000; // later spawn = finished later
			w.result = `result ${i}`;
		}
		return w;
	});
	return Object.assign(new EventEmitter(), { list: () => workers });
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}
const show = (title: string, lines: string[]) => {
	if (!verbose) return;
	console.log(`  --- ${title}`);
	for (const l of lines) console.log(`  ${stripAnsi(l)}|`);
};
const rowNames = (lines: string[]) => lines.slice(2).map((l) => /worker-\d+/.exec(l)?.[0]).filter(Boolean);

// ------------------------------------------------------------ widget

{
	const lines = ui.widgetLines(fakeSource(["done", "done", "running", "running", "running"]), 120);
	show("widget, 5 workers", lines);
	check("widget 5 workers: 7 lines, no more-line", lines.length === 7 && !lines.some((l: string) => l.includes("more (")));
	check(
		"widget 5 workers: running first, then done newest first",
		rowNames(lines).join(",") === "worker-3,worker-4,worker-5,worker-2,worker-1",
		rowNames(lines).join(","),
	);
}

// 12 workers: 3 done (1-3), 7 running (4-10), 1 crashed (11), 1 stopped (12). 8 rows -> 7 running + crashed shown.
const twelve: Kind[] = ["done", "done", "done", ...Array(7).fill("running"), "crashed", "stopped"];
{
	const source = fakeSource(twelve);
	const lines = ui.widgetLines(source, 120);
	show("widget, 12 workers", lines);
	const names = rowNames(lines.slice(0, -1));
	check("widget 12 workers: 2 + 8 rows + more-line = 11 lines", lines.length === 11, `got ${lines.length}`);
	check(
		"widget 12 workers: all 7 running + the crashed one are visible",
		names.join(",") === "worker-4,worker-5,worker-6,worker-7,worker-8,worker-9,worker-10,worker-11",
		names.join(","),
	);
	check(
		"widget 12 workers: more-line names what is hidden",
		lines.at(-1)!.includes("… 4 more (3 done, 1 stopped)"),
		stripAnsi(lines.at(-1)!),
	);
	check("widget 12 workers: every line fits the width", lines.every((l: string) => visibleWidth(l) <= 120));

	// Clicks map to the rendered rows.
	const opened: (string | undefined)[] = [];
	const widget = ui.createWidgetComponent(source, plain, (name?: string) => opened.push(name));
	widget.render(120);
	const click = (y: number) => widget.handleMouse({ type: "click", button: "left", x: 5, y });
	click(2); // first worker row
	click(9); // last worker row
	click(10); // "… 4 more" line
	click(0); // summary
	check(
		"widget clicks: first row, last row, more-line (newest hidden: worker-3), summary",
		JSON.stringify(opened) === JSON.stringify(["worker-4", "worker-11", "worker-3", null]),
		JSON.stringify(opened),
	);
}

// PI_MULTI_AGENT_WIDGET_ROWS (read at load; a query string gives a fresh module instance).
{
	process.env.PI_MULTI_AGENT_WIDGET_ROWS = "3";
	const ui3 = await import(`${extensionModule("ui.ts")}?rows=3`);
	delete process.env.PI_MULTI_AGENT_WIDGET_ROWS;
	const lines = ui3.widgetLines(fakeSource(twelve), 120);
	show("widget, 12 workers, PI_MULTI_AGENT_WIDGET_ROWS=3", lines);
	check(
		"PI_MULTI_AGENT_WIDGET_ROWS=3: 3 rows + more-line",
		lines.length === 6 && lines.at(-1)!.includes("… 9 more (4 running, 1 crashed, 3 done, 1 stopped)"),
		stripAnsi(lines.at(-1)!),
	);
}

// ------------------------------------------------------------ viewer tab bar

function viewerAt(source: ReturnType<typeof fakeSource>, current: string) {
	return ui.createViewer(source, current, { requestRender() {} }, plain, noKeys, () => {});
}

for (const width of [120, 80, 60]) {
	const source = fakeSource(Array(10).fill("running"));
	const viewer = viewerAt(source, "worker-1");
	const bars: string[] = [];
	let starts: string[] = []; // first visible tab after each step
	let ok = true;
	let detail = "";
	for (let k = 1; k <= 10; k++) {
		const bar = viewer.render(width)[0]!;
		bars.push(bar);
		const text = stripAnsi(bar);
		const hasCurrent = text.includes(`[ worker-${k} ]`);
		const hasCounter = text.includes(`worker ${k}/10`);
		const fitsWidth = visibleWidth(bar) <= width && !text.includes("...");
		if (!(hasCurrent && hasCounter && fitsWidth)) {
			ok = false;
			detail ||= `step ${k}: current=${hasCurrent} counter=${hasCounter} fits=${fitsWidth}: ${text}`;
		}
		starts.push(/^ (?:‹ \d+ )?\s*(?:\[ )?[✓●✗■○◌]?\s*(worker-\d+)/.exec(text)?.[1] ?? "?");
		viewer.handleInput(RIGHT);
	}
	show(`viewer tab bar, 10 workers, width ${width}, worker-1 / worker-5 / worker-10`, [bars[0]!, bars[4]!, bars[9]!]);
	check(`viewer width ${width}: current tab and counter always visible, nothing cut off`, ok, detail);
	const first = stripAnsi(bars[0]!);
	const last = stripAnsi(bars[9]!);
	check(
		`viewer width ${width}: markers only where tabs are hidden`,
		!first.includes("‹") && (width >= 160 || first.includes("›")) && last.includes("‹") && !last.includes("›"),
		`first: ${first}\n      last:  ${last}`,
	);
	// The window moves only when the current tab would leave it: the first visible tab never moves backwards
	// and stays put for at least the first two steps.
	const idx = starts.map((s) => Number(s.split("-")[1]));
	check(
		`viewer width ${width}: window scrolls forward only when needed`,
		idx.every((v, i) => i === 0 || v >= idx[i - 1]!) && idx[1] === idx[0],
		starts.join(" "),
	);
	viewer.dispose();
	starts = [];
}

// Marker clicks switch to the nearest hidden worker on that side.
{
	const source = fakeSource(Array(10).fill("running"));
	const viewer = viewerAt(source, "worker-10");
	const bar = stripAnsi(viewer.render(80)[0]!);
	const hiddenLeft = Number(/‹ (\d+)/.exec(bar)?.[1]);
	viewer.handleMouse({ type: "click", button: "left", x: visibleWidth(bar.slice(0, bar.indexOf("‹"))), y: 0 });
	const after = stripAnsi(viewer.render(80)[0]!);
	check(
		`viewer: click on "‹ ${hiddenLeft}" switches to worker-${hiddenLeft}`,
		after.includes(`[ worker-${hiddenLeft} ]`),
		after,
	);
	viewer.dispose();

	const v2 = viewerAt(source, "worker-1");
	const bar2 = stripAnsi(v2.render(80)[0]!);
	const m = /(\d+) ›/.exec(bar2);
	const hiddenRight = Number(m?.[1]);
	v2.handleMouse({ type: "click", button: "left", x: visibleWidth(bar2.slice(0, m?.index ?? 0)), y: 0 });
	const after2 = stripAnsi(v2.render(80)[0]!);
	const expected = 10 - hiddenRight + 1;
	check(
		`viewer: click on "${hiddenRight} ›" switches to worker-${expected}`,
		after2.includes(`[ worker-${expected} ]`),
		after2,
	);
	v2.dispose();
}

// Few workers: no markers, unchanged layout.
{
	const viewer = viewerAt(fakeSource(["done", "running", "running"]), "worker-2");
	const bar = stripAnsi(viewer.render(120)[0]!);
	show("viewer tab bar, 3 workers", [bar]);
	check("viewer 3 workers: all tabs, no markers", /worker-1.*worker-2.*worker-3/.test(bar) && !/[‹›]/.test(bar), bar);
	viewer.dispose();
}

// Long names: the current tab must still be visible.
{
	const source = fakeSource(Array(6).fill("running"), (i) => `backend-lesson-reviewer-${i}`);
	const viewer = viewerAt(source, "backend-lesson-reviewer-6");
	const bar = stripAnsi(viewer.render(90)[0]!);
	show("viewer tab bar, long names, width 90", [bar]);
	check(
		"viewer long names: current tab and counter visible",
		bar.includes("[ backend-lesson-reviewer-6 ]") && bar.includes("worker 6/6") && !bar.includes("..."),
		bar,
	);
	viewer.dispose();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
