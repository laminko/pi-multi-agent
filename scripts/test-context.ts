/**
 * Checks for the Ctx column: context in use as a percentage of the model's context window (format.ts fmtContext),
 * in the status table, the widget, the stats line, and from a real worker process (the window comes from get_state).
 * No model calls: this script also plays the worker (`--mode rpc`).
 *
 *   node scripts/test-context.ts
 *
 * Needs Node >= 22.18. pi's own packages are found through the `pi` on PATH (see scripts/lib/pi-packages.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

if (process.argv.includes("--mode")) fakeWorker();
else await main();

/** A stand-in for `pi --mode rpc`: model window 200k; every task ends with a call of 54,000 context tokens. */
function fakeWorker(): void {
	const out = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
	readline.createInterface({ input: process.stdin }).on("line", (line) => {
		const cmd = JSON.parse(line);
		const reply = (data: object = {}) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
		if (cmd.type === "get_state") return reply({ model: { provider: "fake", id: "m", contextWindow: 200_000 }, isStreaming: false });
		if (cmd.type !== "prompt") return reply({});
		reply({});
		out({ type: "agent_start" });
		out({ type: "turn_start" });
		out({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 5, totalTokens: 54_000, cost: { total: 0 } } },
		});
		out({ type: "agent_settled", aborted: false });
	});
	process.stdin.on("end", () => process.exit(0));
}

async function main(): Promise<void> {
	const { extensionModule } = await import("./lib/pi-packages.ts");
	const { Worker } = await import(extensionModule("worker.ts"));
	const F = await import(extensionModule("format.ts"));
	const { widgetLines, createWidgetComponent } = await import(extensionModule("ui.ts"));

	let failures = 0;
	const check = (name: string, ok: boolean, detail = "") => {
		if (!ok) failures++;
		console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
	};
	const host = { dialog: async () => ({ cancelled: true }), notify() {} };
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-ctx-"));
	const mk = (tokens: number, window?: number, name = "w") => {
		const w = new Worker({ name, cwd: "/tmp", runDir, notify: true }, host);
		w.status = "idle";
		w.usage.contextTokens = tokens;
		w.contextWindow = window;
		return w;
	};

	// ------------------------------------------------------------ formatting
	const cases: [number, number | undefined, string][] = [
		[0, 200_000, "0%"],
		[150, 1_000_000, "<0.1%"],
		[3_800, 1_000_000, "0.4%"],
		[5_000, 200_000, "2.5%"],
		[20_000, 200_000, "10%"],
		[54_000, 200_000, "27%"],
		[199_000, 200_000, "100%"],
		[3_800, undefined, "3.8k"],
	];
	for (const [tokens, window, want] of cases) {
		const got = F.fmtContext(mk(tokens, window));
		check(`fmtContext ${tokens} of ${window ?? "unknown"} → ${want}`, got === want, `got ${got}`);
	}

	// ------------------------------------------------------------ table, stats line, legend, widget
	const a = mk(54_000, 200_000, "alpha");
	const b = mk(3_800, undefined, "beta");
	const table = F.statusTable([a, b]);
	const ctxCell = (name: string) =>
		table
			.split("\n")
			.map((l: string) => l.split("|").map((c) => c.trim()))
			.find((c: string[]) => c[2] === name)?.[5];
	check(
		"status table: Ctx column shows % (and tokens when the window is unknown)",
		ctxCell("alpha") === "27%" && ctxCell("beta") === "3.8k",
		`${ctxCell("alpha")} / ${ctxCell("beta")}\n${table}`,
	);
	check("legend explains the %", table.includes("as % of the model's context window"));
	check("stats line: % with tokens of window", F.statsText(a).includes("ctx 27% (54k of 200k)") && F.statsText(b).includes("ctx 3.8k"), `${F.statsText(a)}\n${F.statsText(b)}`);
	const wl = widgetLines({ list: () => [a, b], on() {}, off() {} }, 160).join("\n");
	check("widget lines: % in the Ctx column", /alpha .* 27% /.test(wl), wl);

	// Warning color at >= 80%.
	const full = mk(170_000, 200_000, "full");
	const colors: string[] = [];
	const theme = { fg: (c: string, s: string) => (s.includes("85%") && colors.push(c), s), bold: (s: string) => s, italic: (s: string) => s };
	createWidgetComponent({ list: () => [full], on() {}, off() {} } as any, theme as any, () => {}).render(160);
	check("widget: Ctx >= 80% in the warning color", colors.includes("warning"), JSON.stringify(colors));
	const colors2: string[] = [];
	const theme2 = { fg: (c: string, s: string) => (s.includes("27%") && colors2.push(c), s), bold: (s: string) => s, italic: (s: string) => s };
	createWidgetComponent({ list: () => [a], on() {}, off() {} } as any, theme2 as any, () => {}).render(160);
	check("widget: Ctx below 80% stays dim", colors2.length > 0 && !colors2.includes("warning"), JSON.stringify(colors2));

	// ------------------------------------------------------------ a real (fake) worker process
	const w = new Worker({ name: "proc", cwd: process.cwd(), runDir, notify: true }, host);
	(w as any).config.extraArgs = [];
	await w.start();
	check("worker reads the context window from get_state", w.contextWindow === 200_000, String(w.contextWindow));
	await w.prompt("go");
	const end = Date.now() + 5000;
	while (w.busy && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	check("after a task: Ctx 27%", F.fmtContext(w) === "27%" && /\|\s+27% \|/.test(F.statusTable([w])), F.statusTable([w], { legend: false }));
	await w.stop();

	console.log(failures ? `\n${failures} failed` : "\nall passed");
	process.exit(failures ? 1 : 0);
}
