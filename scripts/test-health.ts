/**
 * Checks for the health checks (health.ts): settings from the environment, verdicts, alert timing, the warning in the
 * status table and widget, and the whole loop inside the extension: heartbeats to real worker processes, alerts to the
 * manager, and a wait that stops early. No model calls: this script also plays the worker (`--mode rpc`, see
 * fakeWorker), so the extension runs real child processes that misbehave on purpose.
 *
 *   node scripts/test-health.ts
 *
 * Needs Node >= 22.18. pi's own packages are found through the `pi` on PATH (see scripts/lib/pi-packages.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

if (process.argv.includes("--mode")) fakeWorker();
else await main();

/**
 * A stand-in for `pi --mode rpc`. The extension starts it as a worker, because it launches process.argv[1]. The
 * behavior comes from the worker name (`--name worker:<behavior>-<n>`):
 *   quiet   starts `bash sleep 999` and then sends nothing, but answers status checks
 *   freeze  the same, then stops answering anything, like a blocked process
 *   loop    makes the same `read` call 6 times, then sends nothing
 */
function fakeWorker(): void {
	const name = process.argv[process.argv.indexOf("--name") + 1] ?? "";
	const behavior = name.replace(/^worker:/, "").split("-")[0];
	let streaming = false;
	let frozen = false;
	const out = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		if (frozen) return;
		let cmd: any;
		try {
			cmd = JSON.parse(line);
		} catch {
			return;
		}
		const reply = (data: object = {}) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
		switch (cmd.type) {
			case "get_state":
				reply({ isStreaming: streaming, isCompacting: false, pendingMessageCount: 0 });
				return;
			case "prompt":
				reply({});
				streaming = true;
				out({ type: "agent_start" });
				out({ type: "turn_start" });
				if (behavior === "loop") {
					for (let i = 0; i < 6; i++) {
						out({ type: "tool_execution_start", toolName: "read", args: { path: "same.txt" } });
						out({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "x" }] } });
					}
					return;
				}
				out({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep 999" } });
				if (behavior === "freeze") frozen = true;
				return;
			case "abort":
				reply({});
				streaming = false;
				out({ type: "agent_settled", aborted: true });
				return;
			default:
				reply({});
		}
	});
	rl.on("close", () => process.exit(0));
}

async function main(): Promise<void> {
	const { extensionModule } = await import("./lib/pi-packages.ts");
	const { Worker, freshHealth } = await import(extensionModule("worker.ts"));
	const H = await import(extensionModule("health.ts"));
	const { statusTable } = await import(extensionModule("format.ts"));
	const { widgetLines } = await import(extensionModule("ui.ts"));

	let failures = 0;
	const check = (name: string, ok: boolean, detail = "") => {
		if (!ok) failures++;
		console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
	};
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const until = async (ok: () => boolean, ms: number) => {
		const end = Date.now() + ms;
		while (!ok() && Date.now() < end) await sleep(100);
		return ok();
	};

	// ------------------------------------------------------------ settings

	const d = H.readHealthConfig({});
	check("defaults: check every 10 s, quiet after 180 s, 5 s heartbeat timeout", d.intervalMs === 10_000 && d.stallMs === 180_000 && d.pingTimeoutMs === 5000);
	const c = H.readHealthConfig({ PI_MULTI_AGENT_HEALTH_INTERVAL: "3", PI_MULTI_AGENT_STALL_SECONDS: "60" });
	check("env: interval 3 s, stall 60 s, heartbeat timeout <= interval", c.intervalMs === 3000 && c.stallMs === 60_000 && c.pingTimeoutMs === 3000);
	check(
		"env: 0 or off turns checks off",
		H.readHealthConfig({ PI_MULTI_AGENT_HEALTH_INTERVAL: "0" }).intervalMs === 0 &&
			H.readHealthConfig({ PI_MULTI_AGENT_HEALTH_INTERVAL: " OFF " }).intervalMs === 0,
	);
	const junk = H.readHealthConfig({ PI_MULTI_AGENT_HEALTH_INTERVAL: "soon", PI_MULTI_AGENT_STALL_SECONDS: "-5" });
	check(
		"env: invalid values fall back to the defaults; intervals below 1 s become 1 s",
		junk.intervalMs === 10_000 && junk.stallMs === 180_000 && H.readHealthConfig({ PI_MULTI_AGENT_HEALTH_INTERVAL: "0.2" }).intervalMs === 1000,
	);

	// ------------------------------------------------------------ verdicts and alert timing (no processes)

	const cfg = { intervalMs: 10_000, stallMs: 180_000, pingTimeoutMs: 5000, maxPingFailures: 3, loopRepeats: 5 };
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-health-unit-"));
	const host = { dialog: async () => ({ cancelled: true }), notify() {} };
	const t = Date.now();
	const busyWorker = (name: string, quietMs: number) => {
		const w = new Worker({ name, cwd: "/tmp", runDir, notify: true }, host);
		w.status = "running";
		w.busy = true;
		w.activity = "bash $ npm run dev";
		w.taskStartedAt = t - 400_000;
		w.lastEventAt = t - quietMs;
		return w;
	};

	check("recent output: ok", H.assessHealth(busyWorker("a", 5000), t, cfg).state === "ok");
	const q = busyWorker("b", 200_000);
	const qv = H.assessHealth(q, t, cfg);
	check(
		"no output for 200 s: quiet, since the last event, with the activity",
		qv.state === "quiet" && qv.since === q.lastEventAt && qv.detail.includes("3m20s") && qv.detail.includes("npm run dev"),
		JSON.stringify(qv),
	);
	const idle = busyWorker("c", 999_000);
	idle.busy = false;
	check("not busy: ok, however long ago its last event", H.assessHealth(idle, t, cfg).state === "ok");
	const un = busyWorker("d", 200_000);
	un.health.failures = 3;
	un.health.firstFailureAt = t - 25_000;
	const uv = H.assessHealth(un, t, cfg);
	check("3 unanswered status checks: unresponsive (before quiet)", uv.state === "unresponsive" && uv.since === t - 25_000);
	const dlg = busyWorker("e", 200_000);
	dlg.dialogs = 1;
	dlg.dialogTitle = "Allow rm -rf?";
	check("open dialog: waiting, not quiet", H.assessHealth(dlg, t, cfg).state === "waiting");
	const lp = busyWorker("f", 1000);
	lp.repeatCount = 5;
	lp.repeatLabel = "read same.txt";
	lp.repeatSince = t - 3000;
	check("5 identical tool calls: looping", H.assessHealth(lp, t, cfg).state === "looping");
	const ds = busyWorker("g", 200_000);
	ds.health.remote = { isStreaming: false, isCompacting: false };
	check("pi reports no run while busy: said in the detail", H.assessHealth(ds, t, cfg).detail.includes("no run in progress"));

	// Alert timing: one alert per problem, then again when it lasted about twice as long; recovery keeps the count.
	const w = busyWorker("timing", 180_000);
	const step = (now: number) => H.updateHealth(w, H.assessHealth(w, now, cfg), now, cfg);
	const a1 = step(t);
	const a2 = step(t + 10_000);
	const a3 = step(t + 180_000);
	const a4 = step(t + 200_000);
	check(
		"alert at 3m quiet, none 10 s later, again at 6m quiet, then not before 12m",
		a1.kind === "alert" && !a1.repeat && a2.kind === "none" && a3.kind === "alert" && a3.repeat && a4.kind === "none" &&
			w.health.alerts === 2 && w.health.nextAlertAt === t + 180_000 + 360_000,
		JSON.stringify([a1, a2, a3, a4, w.health.nextAlertAt! - t]),
	);
	const table = statusTable([w], { legend: false });
	const widget = widgetLines({ list: () => [w], on() {}, off() {} }, 160).join("\n");
	check("status table and widget show the warning", /⚠ quiet \d/.test(table) && widget.includes("1 may be stuck") && widget.includes("⚠ quiet"), `${table}\n${widget}`);
	w.lastEventAt = Date.now(); // the worker moves: the warning goes at once, before the next check
	check("the warning goes away as soon as the worker moves", !statusTable([w]).includes("⚠ quiet"));
	const a5 = step(Date.now());
	check("recovery: reported with alerted=true; the alert count is kept", a5.kind === "recovered" && a5.alerted && w.health.alerts === 2);
	check("a new task keeps the alert count (freshHealth)", freshHealth(2).alerts === 2 && freshHealth(2).state === "ok");
	const wd = busyWorker("dialog", 0);
	wd.dialogs = 1;
	check("waiting for a dialog changes the state without an alert", H.updateHealth(wd, H.assessHealth(wd, t, cfg), t, cfg).kind === "changed" && wd.health.alerts === 0);

	// Alert text for the manager.
	const wq = busyWorker("build", 200_000);
	H.updateHealth(wq, H.assessHealth(wq, t, cfg), t, cfg);
	const text = H.healthAlertText(wq, cfg, false);
	check(
		"alert text: headline, table, settings, advice, tell the user",
		text.startsWith('Worker "build" may be stuck (quiet): no output for 3m20s') &&
			text.includes("| build") &&
			text.includes("health checks: every 10s") &&
			text.includes('worker_status "build"') &&
			text.includes('mode "abort"') &&
			text.includes("tell the user"),
		text,
	);
	check("advice for a process that does not answer: kill it", (H.updateHealth(un, uv, t, cfg), H.healthFollowUp(un).includes('mode "kill"')));

	// ------------------------------------------------------------ the extension, with real (fake) worker processes

	process.env.PI_MULTI_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-health-"));
	process.env.PI_MULTI_AGENT_HEALTH_INTERVAL = "1";
	process.env.PI_MULTI_AGENT_STALL_SECONDS = "2";
	delete process.env.PI_MULTI_AGENT_ROLE;
	delete process.env.PI_MULTI_AGENT_WORKER_ARGS;
	const { default: multiAgent } = await import(extensionModule("index.ts"));

	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const renderers = new Map<string, any>();
	const sent: any[] = [];
	const toasts: { message: string; level: string }[] = [];
	multiAgent({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {},
		registerMessageRenderer: (type: string, r: any) => renderers.set(type, r),
		on: (event: string, h: any) => handlers.set(event, h),
		sendMessage: (message: any, options: any) => sent.push({ ...message, options }),
		appendEntry() {},
	});
	const ctx = {
		hasUI: true,
		mode: "rpc",
		cwd: process.cwd(),
		ui: { notify: (message: string, level: string) => toasts.push({ message, level }), setWidget() {} },
		sessionManager: { getSessionId: () => "health-test", getBranch: () => [] },
		hasPendingMessages: () => false,
	};
	const call = (name: string, params: object) => tools.get(name).execute("call", params, undefined, undefined, ctx);
	const text0 = (r: any) => String(r?.content?.[0]?.text ?? "");
	const alertFor = (name: string, state: string) => sent.find((m) => m.customType === "multi-agent-health" && m.details?.name === name && m.details?.state === state);
	await handlers.get("session_start")({}, ctx);

	const pids: number[] = [];
	for (const name of ["quiet-1", "freeze-1", "loop-1"]) {
		const r = await call("worker_spawn", { name, task: "do the thing" });
		pids.push(Number(text0(r).match(/pid (\d+)/)?.[1]));
	}
	await until(() => !!(alertFor("quiet-1", "quiet") && alertFor("freeze-1", "unresponsive") && alertFor("loop-1", "looping")), 15_000);
	const quiet = alertFor("quiet-1", "quiet");
	check(
		"quiet worker: alert to the manager as a follow-up that triggers a turn",
		!!quiet && quiet.options?.deliverAs === "followUp" && quiet.options?.triggerTurn === true && String(quiet.content).includes("What to do"),
		JSON.stringify(sent.map((m) => m.details)),
	);
	check("quiet worker: its process answers status checks", !!quiet && String(quiet.content).includes("still answers status checks"), quiet?.content);
	check("frozen worker: unresponsive alert", !!alertFor("freeze-1", "unresponsive"), JSON.stringify(sent.map((m) => m.details)));
	check("looping worker: looping alert", !!alertFor("loop-1", "looping"), JSON.stringify(sent.map((m) => m.details)));
	check("you get a warning toast too", toasts.some((x) => x.level === "warning" && x.message.startsWith("Worker quiet-1 may be stuck")));
	const perWorker = sent.filter((m) => m.customType === "multi-agent-health" && m.details?.name === "quiet-1").length;
	check("one alert per problem, not one per check", perWorker === 1, `quiet-1 alerts: ${perWorker}`);

	const status = text0(await call("worker_status", {}));
	check("worker_status shows the warnings and the settings", status.includes("⚠ quiet") && status.includes("⚠ not answering") && status.includes("⚠ loop ×6") && status.includes("health checks: every 1s"), status);
	const detail = text0(await call("worker_status", { name: "quiet-1" }));
	check("worker_status <name> has a health line", /health: quiet: no output for \d+s/.test(detail), detail);

	const logs = status.match(/^logs: (.*)$/m)?.[1] ?? "";
	const events = fs.readFileSync(path.join(logs, "quiet-1.events.jsonl"), "utf8");
	const stateReplies = events.split("\n").filter((l) => l.includes('"command":"get_state"')).length;
	check("heartbeat replies stay out of <name>.events.jsonl (only the startup get_state)", stateReplies === 1, `get_state replies logged: ${stateReplies}`);

	// A wait on a worker that gets stuck stops early, and the alert comes with the wait instead of as a message.
	const before = sent.length;
	const t0 = Date.now();
	const waited = await call("worker_spawn", { name: "quiet-2", task: "x", wait: true, timeoutSeconds: 30 });
	const took = Date.now() - t0;
	check(
		"worker_wait stops early (outcome stalled) with the follow-up advice",
		waited.details?.outcome === "stalled" && took < 10_000 && text0(waited).includes("Wait stopped early") && text0(waited).includes('Worker "quiet-2" may be stuck'),
		`${waited.details?.outcome} after ${took} ms\n${text0(waited)}`,
	);
	check("no separate alert message while a wait covers the worker", !sent.slice(before).some((m) => m.details?.name === "quiet-2"));

	// The TUI view of an alert message.
	try {
		const { initTheme } = await import("@earendil-works/pi-coding-agent");
		initTheme?.();
		const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s };
		const view = renderers.get("multi-agent-health")(quiet, { expanded: false, outputPad: 1, keyHint: () => "ctrl+o to expand" }, plain);
		const lines = view.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		check("alert message view: header and drawn table", lines.includes("⚠ worker quiet-1 may be stuck (quiet)") && lines.includes("quiet-1") && !lines.includes("|---"), lines);
	} catch (error) {
		console.log(`SKIP  alert message view (${error instanceof Error ? error.message : String(error)})`);
	}

	// An aborted task settles: the health state resets.
	await call("worker_stop", { name: "quiet-1" });
	await sleep(300);
	const after = text0(await call("worker_status", {}));
	check("after an abort the warning is gone", !/\| quiet-1 [^\n]*⚠/.test(after), after);

	await handlers.get("session_shutdown")({}, ctx);
	await sleep(300);
	const alive = pids.filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
	check("no worker process left after shutdown", pids.length === 3 && pids.every(Boolean) && alive.length === 0, `alive: ${alive.join(", ")}`);

	console.log(failures ? `\n${failures} failed` : "\nall passed");
	process.exit(failures ? 1 : 0);
}
