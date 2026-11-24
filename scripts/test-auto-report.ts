/**
 * End-to-end test: after worker_spawn the manager ends its turn, and the worker
 * result arrives by itself.
 *
 *   node scripts/test-auto-report.ts [model]
 *
 * Acceptance: 0 worker_wait calls; 1 "Worker sleeper done" notify; the manager
 * starts a new turn after the worker finishes (2 agent_end events in total).
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const model = process.argv[2] ?? "claude-code/claude-haiku-5-5";
const pi = spawn("pi", ["--mode", "rpc", "--no-session", "--model", model, "--thinking", "off"], {
	stdio: ["pipe", "pipe", "inherit"],
});
const send = (o: object) => pi.stdin.write(`${JSON.stringify(o)}\n`);

let waits = 0; // worker_wait calls plus wait=true on worker_spawn / worker_send
let toasts = 0;
let agentEnds = 0;
let lastText = "";
const deadline = setTimeout(() => done(), 150_000);

function done() {
	clearTimeout(deadline);
	const fails: string[] = [];
	if (waits !== 0) fails.push(`blocking waits ${waits}, expected 0`);
	if (toasts !== 1) fails.push(`notify toasts ${toasts}, expected 1`);
	if (agentEnds < 2) fails.push(`agent_end ${agentEnds}, expected >= 2`);
	console.log(`[result] worker_wait=${waits} toasts=${toasts} agent_end=${agentEnds}`);
	console.log(`[last manager text] ${lastText.slice(0, 300)}`);
	console.log(fails.length ? `FAIL: ${fails.join("; ")}` : "PASS");
	pi.kill();
	process.exit(fails.length ? 1 : 0);
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
	if (ev.type === "extension_ui_request" && ev.method === "notify" && /Worker sleeper/.test(ev.message ?? "")) {
		toasts++;
		console.log(`[toast] ${ev.message}`);
	}
	if (ev.type === "tool_execution_start") {
		console.log(`[tool start] ${ev.toolName}`);
		if (ev.toolName === "worker_wait" || ev.args?.wait === true) waits++;
	}
	if (ev.type === "message_end" && ev.message?.role === "assistant") {
		const t = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		if (t) lastText = t;
	}
	if (ev.type === "agent_end") {
		agentEnds++;
		console.log(`[agent_end #${agentEnds}]`);
		if (agentEnds >= 2) setTimeout(done, 1000);
	}
});

send({
	type: "prompt",
	message:
		'Spawn one worker named "sleeper" with tools "bash" and this task: "Run the bash command: sleep 10. Then reply with the word done." ' +
		"Follow your normal worker guidelines after that.",
});
