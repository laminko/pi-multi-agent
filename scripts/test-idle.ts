/**
 * Checks for the idle cleanup (idle.ts): settings from the environment, the reap rule, and the whole loop inside the
 * extension: a finished worker's process is stopped after the idle time, stays listed, and worker_send revives it on
 * its own session file. No model calls: this script also plays the worker (`--mode rpc`, see fakeWorker).
 *
 *   node scripts/test-idle.ts
 *
 * Needs Node >= 22.18. pi's own packages are found through the `pi` on PATH (see scripts/lib/pi-packages.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

if (process.argv.includes("--mode")) fakeWorker();
else await main();

/** A stand-in for `pi --mode rpc` that answers every prompt with "ok <n>" at once. Reports its --session argument. */
function fakeWorker(): void {
	const i = process.argv.indexOf("--session");
	const sessionFile = i > 0 ? process.argv[i + 1] : path.join(os.tmpdir(), `fake-session-${process.pid}.jsonl`);
	const resumed = i > 0;
	if (!resumed) fs.writeFileSync(sessionFile, "");
	let n = 0;
	const out = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		let cmd: any;
		try {
			cmd = JSON.parse(line);
		} catch {
			return;
		}
		const reply = (data: object = {}) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
		if (cmd.type === "get_state") return reply({ sessionFile, sessionId: "s", isStreaming: false });
		if (cmd.type !== "prompt") return reply({});
		reply({});
		n++;
		out({ type: "agent_start" });
		out({ type: "turn_start" });
		const text = `ok ${n}${resumed ? " (resumed session)" : ""}`;
		out({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 10, output: 5, cost: { total: 0.01 } } },
		});
		out({ type: "agent_settled", aborted: false });
	});
	rl.on("close", () => process.exit(0));
}

async function main(): Promise<void> {
	const { extensionModule } = await import("./lib/pi-packages.ts");
	const I = await import(extensionModule("idle.ts"));
	const { Worker } = await import(extensionModule("worker.ts"));

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

	const d = I.readIdleConfig({});
	check("default: 10 min, checked every 30 s", d.idleMs === 600_000 && d.intervalMs === 30_000);
	check("env: 0 / off turn it off", I.readIdleConfig({ PI_MULTI_AGENT_IDLE_MINUTES: "0" }).idleMs === 0 && I.readIdleConfig({ PI_MULTI_AGENT_IDLE_MINUTES: "OFF" }).intervalMs === 0);
	const f = I.readIdleConfig({ PI_MULTI_AGENT_IDLE_MINUTES: "0.05" });
	check("env: fractions allowed; check interval at least 1 s", f.idleMs === 3000 && f.intervalMs === 1000, JSON.stringify(f));
	check("env: invalid falls back to the default", I.readIdleConfig({ PI_MULTI_AGENT_IDLE_MINUTES: "-3" }).idleMs === 600_000);

	// ------------------------------------------------------------ reap rule (no processes)

	const cfg = { idleMs: 600_000, intervalMs: 30_000 };
	const host = { dialog: async () => ({ cancelled: true }), notify() {} };
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-idle-unit-"));
	const t = Date.now();
	const idleWorker = (idleMs: number) => {
		const w: any = new Worker({ name: "w", cwd: "/tmp", runDir, notify: true }, host);
		Object.defineProperty(w, "alive", { get: () => true });
		w.status = "idle";
		w.taskFinishedAt = t - idleMs;
		return w;
	};
	check("idle 11 min: reaped", I.shouldReap(idleWorker(660_000), t, cfg));
	check("idle 9 min: kept", !I.shouldReap(idleWorker(540_000), t, cfg));
	const busy = idleWorker(660_000);
	busy.busy = true;
	check("busy: kept", !I.shouldReap(busy, t, cfg));
	check("someone waits on it: kept", !I.shouldReap(idleWorker(660_000), t, cfg, true));
	const dlg = idleWorker(660_000);
	dlg.dialogs = 1;
	check("open dialog: kept", !I.shouldReap(dlg, t, cfg));
	const never = idleWorker(0);
	never.taskFinishedAt = undefined;
	never.createdAt = t - 660_000;
	check("never had a task: idle since it was created", I.shouldReap(never, t, cfg));
	check("off: never reaped", !I.shouldReap(idleWorker(99_999_999), t, { idleMs: 0, intervalMs: 0 }));

	// ------------------------------------------------------------ the extension, with fake worker processes

	process.env.PI_MULTI_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-idle-"));
	process.env.PI_MULTI_AGENT_IDLE_MINUTES = String(2 / 60); // 2 s
	process.env.PI_MULTI_AGENT_HEALTH_INTERVAL = "0";
	delete process.env.PI_MULTI_AGENT_ROLE;
	delete process.env.PI_MULTI_AGENT_WORKER_ARGS;
	const { default: multiAgent } = await import(extensionModule("index.ts"));

	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const sent: any[] = [];
	const toasts: { message: string; level: string }[] = [];
	multiAgent({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {},
		registerMessageRenderer() {},
		on: (event: string, h: any) => handlers.set(event, h),
		sendMessage: (message: any) => sent.push(message),
		appendEntry() {},
	});
	const ctx = {
		hasUI: true,
		mode: "rpc",
		cwd: process.cwd(),
		ui: { notify: (message: string, level: string) => toasts.push({ message, level }), setWidget() {} },
		sessionManager: { getSessionId: () => "idle-test", getBranch: () => [] },
		hasPendingMessages: () => false,
	};
	const call = (name: string, params: object) => tools.get(name).execute("call", params, undefined, undefined, ctx);
	const text0 = (r: any) => String(r?.content?.[0]?.text ?? "");
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	await handlers.get("session_start")({}, ctx);

	const r1 = await call("worker_spawn", { name: "helper", task: "first" });
	const pid1 = Number(text0(r1).match(/pid (\d+)/)?.[1]);
	await until(() => sent.length >= 1, 5000);
	check("first task finished and was reported", String(sent[0]?.content).includes("ok 1"), JSON.stringify(sent[0]));

	const r2 = await call("worker_spawn", { name: "keeper", task: "first" });
	const pid2 = Number(text0(r2).match(/pid (\d+)/)?.[1]);
	// Keep "keeper" in use: a new task every second.
	let keep = true;
	const keeper = (async () => {
		while (keep) {
			await sleep(800);
			if (keep) await call("worker_send", { name: "keeper", message: "again" }).catch(() => undefined);
		}
	})();

	await until(() => !alive(pid1), 8000);
	check("idle worker's process stopped after the idle time", !alive(pid1));
	check("a worker that is reused stays alive", alive(pid2));
	const status = text0(await call("worker_status", {}));
	check("it stays listed as stopped, with the revive hint and the setting", /\| ○ +\| helper [^\n]*stopped while idle/.test(status) && status.includes("idle cleanup: worker processes stop after 2s"), status);
	check("you get an info toast", toasts.some((x) => x.level === "info" && /Worker helper stopped after \d+s idle/.test(x.message)), JSON.stringify(toasts));
	check("the manager LLM gets no message for it", sent.length === 1 || sent.every((m) => m.details?.name !== "helper" || String(m.content).includes("ok 1")));

	const r3 = await call("worker_send", { name: "helper", message: "second", wait: true, timeoutSeconds: 10 });
	check("worker_send revives it on its own session (context kept)", text0(r3).includes("ok 1 (resumed session)") && text0(r3).includes("keeps its context"), text0(r3));
	const detail = text0(await call("worker_status", { name: "helper" }));
	check("revived: counters and history carry over", /tasks: 2/.test(detail) && detail.includes("Idle cleanup: process stopped"), detail);

	await call("worker_stop", { name: "helper", mode: "kill" });
	const r4 = await call("worker_send", { name: "helper", message: "third" }).then(text0, (e: Error) => e.message);
	check("a worker killed on purpose is not revived", r4.includes("spawn a new one"), r4);

	keep = false;
	await keeper;
	await handlers.get("session_shutdown")({}, ctx);
	await sleep(300);
	check("no worker process left after shutdown", !alive(pid2));

	console.log(failures ? `\n${failures} failed` : "\nall passed");
	process.exit(failures ? 1 : 0);
}
