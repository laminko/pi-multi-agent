/**
 * End-to-end test: the user can talk to the manager while worker_wait runs.
 *
 *   node scripts/test-wait-interrupt.ts [model]
 *   TEST_MODE=follow_up node scripts/test-wait-interrupt.ts   # Alt+Enter path; default steer
 *
 * Starts a manager pi in RPC mode, makes it spawn a worker that sleeps 60 s and
 * then call worker_wait. When worker_wait starts, the test sends a steer message
 * (as a user typing). Acceptance: worker_wait ends in < 1000 ms with outcome
 * "interrupted", and the worker is still running.
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const model = process.argv[2] ?? "claude-code/claude-haiku-5-5";
const mode = process.env.TEST_MODE === "follow_up" ? "follow_up" : "steer";
const args = ["--mode", "rpc", "--no-session", "--model", model, "--thinking", "off"];
const pi = spawn("pi", args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } });
const send = (o: object) => pi.stdin.write(`${JSON.stringify(o)}\n`);

let waitStart = 0;
let steerSent = 0;
let failed = "";
const deadline = setTimeout(() => finish("timeout: no result in 180 s"), 180_000);

function finish(err?: string) {
	clearTimeout(deadline);
	send({ type: "abort" });
	setTimeout(() => {
		pi.kill();
		if (err) console.log(`FAIL: ${err}`);
		process.exit(err ? 1 : 0);
	}, 2000);
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
	if (ev.type === "tool_execution_start") console.log(`[tool start] ${ev.toolName}`);
	if (ev.type === "tool_execution_start" && ev.toolName === "worker_wait" && !waitStart) {
		waitStart = Date.now();
		setTimeout(() => {
			steerSent = Date.now();
			send({ type: mode, message: "Master here: just say OK, then stop." });
			console.log(`[${mode}] sent ${steerSent - waitStart} ms after worker_wait started`);
		}, 3000);
	}
	if (ev.type === "tool_execution_end" && ev.toolName === "worker_wait" && waitStart) {
		const ms = steerSent ? Date.now() - steerSent : -1;
		const outcome = ev.result?.details?.outcome;
		const running = (ev.result?.details?.workers ?? []).filter((w: any) => w.busy).length;
		console.log(`[result] outcome=${outcome} latency_ms=${ms} workers_still_running=${running}`);
		if (!steerSent) failed = "worker_wait ended before the steer was sent";
		else if (outcome !== "interrupted") failed = `outcome ${outcome}, expected interrupted`;
		else if (ms < 0 || ms >= 1000) failed = `latency ${ms} ms, expected < 1000`;
		else if (running < 1) failed = "worker is not running any more";
		console.log(failed ? `FAIL: ${failed}` : "PASS");
		finish(failed || undefined);
	}
});

send({
	type: "prompt",
	message:
		'Test of the multi-agent extension. I ask you to wait in step 2. Do exactly these 2 steps and nothing else. ' +
		'1) Call worker_spawn with name "sleeper", tools "bash", task "Run the bash command: sleep 60. Then reply done." ' +
		'2) Then call worker_wait with names ["sleeper"] and timeoutSeconds 120.',
});
