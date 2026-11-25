/**
 * End-to-end test: idle cleanup with a real manager, real workers and a real model.
 *
 *   TEST_EXTENSIONS=~/.pi/agent/git/github.com/earendil-works/pi-claude-code \
 *     node scripts/test-idle-live.ts [project dir] [model]
 *
 * Starts a manager pi in RPC mode in the project dir (default: the current dir) with this checkout's extension and
 * PI_MULTI_AGENT_IDLE_MINUTES=0.5. Then:
 *   1. the manager spawns a read-only worker that counts the test functions in the project and remembers a code word;
 *   2. the worker finishes, the result is auto-reported, and nobody uses the worker for 30 s;
 *   3. acceptance: an idle toast, and the worker's process is gone;
 *   4. the manager is asked to use worker_send to ask the same worker for the code word and its count, without
 *      reading files again; acceptance: the worker is revived (tool result says so), answers with the code word
 *      (context kept), and a new pid runs.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";

const cwd = path.resolve(process.argv[2] ?? process.cwd());
const model = process.argv[3] ?? "claude-code/claude-haiku-5-5";
const CODE_WORD = `PELICAN-${Math.floor(Math.random() * 9000 + 1000)}`;
const extension = path.resolve(import.meta.dirname, "..", "extensions", "multi-agent", "index.ts");
const extra = (process.env.TEST_EXTENSIONS ?? "").split(":").filter(Boolean).flatMap((p) => ["-e", p]);
const args = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, ...extra, "--model", model, "--thinking", "off"];
const pi = spawn("pi", args, {
	cwd,
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env, PI_MULTI_AGENT_IDLE_MINUTES: "0.5" },
});
const send = (o: object) => pi.stdin.write(`${JSON.stringify(o)}\n`);

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const alive = (pid?: number) => {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

let phase: "spawn" | "idle" | "revive" | "end" = "spawn";
let pid1: number | undefined;
let pid2: number | undefined;
let resultReported = false;
let idleToastAt = 0;
let reviveText = "";
let answer = "";
let lastText = "";
let aliveAtRevive = false;
const fails: string[] = [];
const deadline = setTimeout(() => finish("timeout"), 360_000);

function finish(why: string) {
	if (phase === "end") return;
	phase = "end";
	clearTimeout(deadline);
	if (!pid1) fails.push("no worker pid from worker_spawn");
	if (!resultReported) fails.push("first result not auto-reported");
	if (!idleToastAt) fails.push("no idle toast");
	if (!reviveText.includes("stopped for being idle")) fails.push("worker_send did not say it revived the worker");
	if (!pid2 || pid2 === pid1 || !aliveAtRevive) fails.push(`no new worker process after revive (pid1 ${pid1}, pid2 ${pid2})`);
	if (!`${answer}\n${lastText}`.includes(CODE_WORD)) fails.push("revived worker did not remember the code word");
	console.log(`[end: ${why}] pid1=${pid1} pid2=${pid2} idleToast=${idleToastAt ? `${((idleToastAt - t0) / 1000).toFixed(1)}s` : "no"}`);
	console.log(`[worker_send result] ${reviveText.slice(0, 600)}`);
	console.log(`[last manager text] ${lastText.slice(0, 500)}`);
	console.log(fails.length ? `FAIL: ${fails.join("; ")}` : "PASS");
	send({ type: "abort" });
	setTimeout(() => {
		pi.kill();
		setTimeout(() => {
			const orphans = [pid1, pid2].filter(alive);
			console.log(orphans.length ? `orphans: ${orphans.join(", ")}` : "0 orphans");
			process.exit(fails.length || orphans.length ? 1 : 0);
		}, 4000);
	}, 3000);
}

function startRevive() {
	phase = "revive";
	console.log(`[${at()}] pid1 ${pid1} alive: ${alive(pid1)}; asking the manager to reuse the worker`);
	if (alive(pid1)) fails.push("worker process still alive after the idle toast");
	send({
		type: "prompt",
		message:
			'Use worker_send with wait=true to ask the existing worker "counter": "Without reading any files again, tell me the ' +
			'code word I gave you and the number of test functions you counted." Then tell me its answer verbatim. Do not spawn a new worker.',
	});
}

readline.createInterface({ input: pi.stdout }).on("line", (line) => {
	let ev: any;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	if (ev.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(ev.method)) {
		send({ type: "extension_ui_response", id: ev.id, cancelled: true });
	}
	if (ev.type === "extension_ui_request" && ev.method === "notify") {
		console.log(`[${at()} toast] ${ev.message}`);
		if (/Worker counter stopped after .* idle/.test(ev.message ?? "")) {
			idleToastAt ||= Date.now();
			if (phase === "idle") setTimeout(startRevive, 1500);
		}
	}
	if (ev.type === "message_end" && ev.message?.role === "custom" && ev.message?.customType === "multi-agent") {
		resultReported = true;
		console.log(`[${at()} result] ${String(ev.message.content).split("\n")[0]}`);
	}
	if (ev.type === "tool_execution_start") console.log(`[${at()} tool] ${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 140)}`);
	if (ev.type === "tool_execution_end") {
		const text = (ev.result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
		console.log(`[${at()} tool end] ${ev.toolName}${ev.isError ? " ERROR" : ""}: ${text.split("\n")[0]?.slice(0, 200)}`);
		if (ev.toolName === "worker_spawn" && phase === "spawn") pid1 = Number(text.match(/pid (\d+)/)?.[1]);
		if (ev.toolName === "worker_send" && phase === "revive") {
			reviveText = text;
			answer = text;
			pid2 = ev.result?.details?.workers?.[0]?.pid;
			aliveAtRevive = alive(pid2);
			console.log(`[${at()}] revived pid ${pid2} alive: ${aliveAtRevive}`);
		}
	}
	if (ev.type === "message_end" && ev.message?.role === "assistant") {
		const t = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		if (t) lastText = t;
	}
	if (ev.type === "agent_settled") {
		console.log(`[${at()} manager settled] phase=${phase}`);
		if (phase === "spawn" && resultReported) {
			phase = "idle";
			console.log(`[${at()}] worker idle now; pid1 ${pid1} alive: ${alive(pid1)}. Waiting for the idle cleanup (30 s)…`);
		}
		if (phase === "revive" && reviveText) {
			setTimeout(() => finish("done"), 500);
		}
	}
});

send({
	type: "prompt",
	message:
		'Spawn one worker named "counter" with tools "read,grep,find,ls" and this task: "Remember this code word: ' +
		CODE_WORD +
		". Count the test functions (def test_...) in tests/test_todo.py in this project. Reply with the number only.\" " +
		"Do not wait for it. When its result arrives, tell me the number in one sentence.",
});
