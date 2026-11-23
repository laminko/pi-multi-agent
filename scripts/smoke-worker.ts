/**
 * Smoke test for the Worker RPC layer, without a manager pi.
 *
 *   node scripts/smoke-worker.ts [model]
 *   SMOKE_THINKING=high SMOKE_TASK="..." node scripts/smoke-worker.ts
 *
 * Spawns one worker pi over RPC, runs a tiny task (one bash call), prints live
 * status changes, the result, usage and log paths, then shuts the worker down.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "../extensions/multi-agent/worker.ts";

// Worker launches pi via process.argv[1] (pi's own CLI when running inside pi). Point it at pi here.
const piBin = execFileSync("sh", ["-c", "command -v pi"]).toString().trim();
const launcher = fs.readFileSync(piBin, "utf8");
if (launcher.startsWith("#!/bin/sh")) {
	// Managed install: resolve the current release's CLI entry.
	const agentDir = path.dirname(path.dirname(fs.realpathSync(piBin)));
	const version = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim();
	process.argv[1] = fs.realpathSync(path.join(agentDir, "install", "releases", version, "node_modules", ".bin", "pi"));
} else {
	process.argv[1] = fs.realpathSync(piBin);
}

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-multi-agent-smoke-"));
const worker = new Worker(
	{ name: "smoke", cwd: process.cwd(), runDir, model: process.argv[2], thinking: process.env.SMOKE_THINKING ?? "low", tools: "bash,read", notify: false },
	{
		dialog: async (_w, req) => {
			console.log(`\n[dialog] ${req.method}: ${req.title} → cancelled`);
			return { cancelled: true };
		},
		notify: (_w, message, level) => console.log(`\n[notify:${level}] ${message}`),
	},
);

let lastLine = "";
worker.on("change", () => {
	const line = `${worker.status.padEnd(8)} turns=${worker.turns} tools=${worker.toolCalls} | ${worker.activity.replace(/\s+/g, " ").slice(0, 70)}`;
	if (line !== lastLine) console.log(line);
	lastLine = line;
});

const t0 = Date.now();
await worker.start();
console.log(`started pid=${worker.pid} model=${worker.model} thinking=${worker.thinkingLevel} in ${Date.now() - t0}ms`);
console.log(`session: ${worker.sessionFile}`);

const settled = new Promise((resolve) => worker.once("settled", resolve));
await worker.prompt(
	process.env.SMOKE_TASK ?? "Run the bash command `echo hello-from-worker`, then reply with exactly one word: pong",
);
await settled;

console.log("\n=== result ===");
console.log({ status: worker.status, result: worker.result, turns: worker.turns, toolCalls: worker.toolCalls, usage: worker.usage });
console.log("transcript kinds:", worker.transcript.map((e) => e.kind).join(" "));

await worker.stop();
console.log(`stopped: status=${worker.status} alive=${worker.alive}`);
console.log(`\n=== ${worker.logPath} ===`);
console.log(fs.readFileSync(worker.logPath, "utf8"));
console.log(`events lines: ${fs.readFileSync(worker.eventsPath, "utf8").trim().split("\n").length}`);
console.log(`stderr: ${JSON.stringify(fs.readFileSync(worker.stderrPath, "utf8").slice(0, 500))}`);
