/**
 * Checks for resume after pi quit: merging worker records, finding interrupted workers, and repairing a worker session
 * that ends in an unfinished tool call. Session files are real (pi's SessionManager) in a temp directory.
 * No model calls.
 *
 *   node scripts/test-resume.ts
 *
 * Needs Node >= 22.18. pi's own packages are found through the `pi` on PATH (see scripts/lib/pi-packages.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extensionModule } from "./lib/pi-packages.ts";

const { RECORD_TYPE, mergeRecords, interruptedRecords, repairSession, oldProcessAlive } = await import(
	extensionModule("resume.ts")
);
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

// ------------------------------------------------------------ records

const rec = (data: object) => ({ type: "custom", customType: RECORD_TYPE, data: { v: 1, ...data } });
const entries = [
	{ type: "message" },
	rec({ name: "a", status: "running", busy: true, task: "task A", sessionFile: "/s/a.jsonl", options: { cwd: "/p", notify: true } }),
	rec({ name: "b", status: "running", busy: true, task: "task B", sessionFile: "/s/b.jsonl" }),
	rec({ name: "b", status: "idle", busy: false }), // b finished
	rec({ name: "c", status: "running", busy: true, task: "task C1" }),
	rec({ name: "c", status: "idle", busy: false }),
	rec({ name: "c", status: "running", busy: true, task: "task C2" }), // c got a second task, then pi quit
	rec({ name: "d", status: "running", busy: true, task: "task D" }),
	rec({ name: "d", status: "stopped", busy: false }), // d was killed
	{ type: "custom", customType: "other", data: { v: 1, name: "x", busy: true } }, // not ours
	{ type: "custom", customType: RECORD_TYPE, data: { v: 2, name: "y", busy: true } }, // unknown version
];
const merged = mergeRecords(entries);
const interruptedNames = interruptedRecords(merged).map((r: any) => r.name).join(",");
check("records: only workers busy at their last record are interrupted (a, c)", interruptedNames === "a,c", interruptedNames);
check("records: later records keep earlier fields (b keeps its session file)", merged.get("b")?.sessionFile === "/s/b.jsonl");
check("records: the latest task wins (c: task C2)", merged.get("c")?.task === "task C2");
check("records: other entry types and versions are ignored", !merged.has("x") && !merged.has("y"));

// ------------------------------------------------------------ session repair

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-test-resume-"));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: any[], stopReason: string) => ({
	role: "assistant", content, api: "test", provider: "test", model: "test", usage, stopReason, timestamp: Date.now(),
});
const toolCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: "sleep 25" } });
const toolResult = (id: string) => ({
	role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now(),
});

function makeSession(build: (sm: any) => void): string {
	const sm = SessionManager.create(dir, dir);
	sm.appendMessage({ role: "user", content: "Step 1: run sleep 25. Step 2: reply done.", timestamp: Date.now() });
	build(sm);
	return sm.getSessionFile();
}
const tail = (file: string) =>
	SessionManager.open(file)
		.getBranch()
		.filter((e: any) => e.type === "message")
		.map((e: any) => e.message.role + (e.message.isError ? "!" : ""))
		.join(",");

// Quit while the model was calling a tool: the session ends with an aborted tool call and no result.
{
	const file = makeSession((sm) => sm.appendMessage(assistant([toolCall("t1")], "aborted")));
	const added = repairSession(file);
	check("repair: unanswered tool call gets an error result", added === 1 && tail(file) === "user,assistant,toolResult!", `${added} ${tail(file)}`);
	check("repair: second run changes nothing", repairSession(file) === 0 && tail(file) === "user,assistant,toolResult!");
	const result = SessionManager.open(file).getBranch().at(-1) as any;
	check("repair: result matches the call id and says why", result.message.toolCallId === "t1" && /interrupted/.test(result.message.content[0].text));
}

// Parallel calls, one already answered.
{
	const file = makeSession((sm) => {
		sm.appendMessage(assistant([toolCall("p1"), toolCall("p2")], "toolUse"));
		sm.appendMessage(toolResult("p1"));
	});
	const added = repairSession(file);
	check("repair: only the unanswered parallel call gets a result", added === 1 && tail(file) === "user,assistant,toolResult,toolResult!", `${added} ${tail(file)}`);
}

// Clean endings: nothing to do.
{
	const done = makeSession((sm) => {
		sm.appendMessage(assistant([toolCall("d1")], "toolUse"));
		sm.appendMessage(toolResult("d1"));
		sm.appendMessage(assistant([{ type: "text", text: "done" }], "stop"));
	});
	const text = makeSession((sm) => sm.appendMessage(assistant([{ type: "text", text: "half an ans" }], "aborted")));
	const userLast = makeSession(() => {});
	check(
		"repair: finished, text-only and user-last sessions are left alone",
		repairSession(done) === 0 && repairSession(text) === 0 && repairSession(userLast) === 0,
	);
}

// ------------------------------------------------------------ old process check

check("oldProcessAlive: no pid, dead pid, and a live non-worker pid are all false",
	!oldProcessAlive(undefined, "a") && !oldProcessAlive(999_999, "a") && !oldProcessAlive(process.pid, "a"));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
