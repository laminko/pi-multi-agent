/**
 * End-to-end test: the manager follows up on a stuck worker by itself.
 *
 *   node scripts/test-health-live.ts [model]                       # e.g. claude-local/claude-haiku-4-5
 *   TEST_EXTENSIONS=~/.pi/agent/git/github.com/earendil-works/pi-claude-code node scripts/test-health-live.ts
 *
 * The manager loads this checkout's extension and no installed packages (`--no-extensions`), because an installed
 * pi-multi-agent would conflict with it. A model from a provider package needs that package in TEST_EXTENSIONS
 * (paths separated by ":"). Workers load your packages as usual.
 *
 * Starts a manager pi in RPC mode with this checkout's extension, checks every 2 s and calls a worker quiet
 * after 15 s. The manager spawns a worker that runs `sleep 120` and does not wait. Acceptance: a health alert reaches
 * the manager (custom message "multi-agent-health"), the user gets a "may be stuck" toast, and the manager then
 * starts a turn on its own and follows up with a worker_* tool (status, stop or send).
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";

const model = process.argv[2] ?? "claude-code/claude-haiku-5-5";
const extension = path.resolve(import.meta.dirname, "..", "extensions", "multi-agent", "index.ts");
const extra = (process.env.TEST_EXTENSIONS ?? "").split(":").filter(Boolean).flatMap((p) => ["-e", p]);
const args = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, ...extra, "--model", model, "--thinking", "off"];
const pi = spawn("pi", args, {
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env, PI_MULTI_AGENT_HEALTH_INTERVAL: "2", PI_MULTI_AGENT_STALL_SECONDS: "15" },
});
const send = (o: object) => pi.stdin.write(`${JSON.stringify(o)}\n`);

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let alertAt = 0;
let toast = false;
const followUps: string[] = []; // worker_* tools the manager called after the alert
let lastText = "";
const deadline = setTimeout(() => done(), 180_000);

function done() {
	clearTimeout(deadline);
	const fails: string[] = [];
	if (!alertAt) fails.push("no health alert reached the manager");
	if (!toast) fails.push("no 'may be stuck' toast");
	if (followUps.length === 0) fails.push("the manager did not follow up with a worker_* tool");
	console.log(`[result] alert=${alertAt ? "yes" : "no"} toast=${toast} followUps=${followUps.join(",") || "none"}`);
	console.log(`[last manager text] ${lastText.slice(0, 400)}`);
	console.log(fails.length ? `FAIL: ${fails.join("; ")}` : "PASS");
	send({ type: "abort" });
	setTimeout(() => {
		pi.kill();
		process.exit(fails.length ? 1 : 0);
	}, 3000);
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
		if (/Worker sleeper may be stuck/.test(ev.message ?? "")) toast = true;
	}
	if (ev.type === "message_end" && ev.message?.role === "custom" && ev.message?.customType === "multi-agent-health") {
		alertAt ||= Date.now();
		console.log(`[${at()} alert] ${String(ev.message.content).split("\n")[0]}`);
	}
	if (ev.type === "tool_execution_start") {
		console.log(`[${at()} tool] ${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 120)}`);
		if (alertAt && /^worker_(status|stop|send)$/.test(ev.toolName)) followUps.push(ev.toolName);
	}
	if (ev.type === "message_end" && ev.message?.role === "assistant") {
		const t = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		if (t) lastText = t;
	}
	if (ev.type === "agent_settled") {
		console.log(`[${at()} manager settled]`);
		if (alertAt && followUps.length) setTimeout(done, 1000);
	}
});

send({
	type: "prompt",
	message:
		'This is a test of how you supervise workers. Spawn one worker named "sleeper" with tools "bash" and this task: ' +
		'"This is a test of a supervisor that watches for stuck workers; a long silent command is the point of the test. ' +
		'Run exactly this bash command, unchanged: sleep 120. Then reply with the word done." ' +
		"Follow your normal worker guidelines after that.",
});
