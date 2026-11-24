/**
 * Resume after pi quit.
 *
 * The manager writes a small custom entry (RECORD_TYPE) into its own session whenever a worker's persistent state
 * changes: a task starts, a task settles, the process exits. Nothing is written while the manager shuts down, so a
 * worker that was busy at quit still has `busy: true` as its last record. When the session is opened again,
 * mergeRecords() rebuilds the last known state of every worker on the current branch.
 *
 * A worker is resumed in its own session file. If pi quit in the middle of a tool call, that session ends with a tool
 * call that has no result, which providers reject; repairSession() appends an error result for each such call first.
 */

import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkerStatus } from "./worker.ts";

export const RECORD_TYPE = "multi-agent-worker";

export interface WorkerOptions {
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string;
	role?: string;
	notify: boolean;
}

/** One record. Fields that are undefined do not overwrite earlier records when merged. */
export interface WorkerRecord {
	v: 1;
	name: string;
	status: WorkerStatus;
	busy: boolean;
	at: number;
	options?: WorkerOptions;
	/** Text of the task that started; only on records written when a new task starts. */
	task?: string;
	sessionFile?: string;
	pid?: number;
	logPath?: string;
}

type EntryLike = { type: string; customType?: string; data?: unknown };

/** Last known state of each worker, from the record entries of a session branch (oldest first). */
export function mergeRecords(entries: readonly EntryLike[]): Map<string, WorkerRecord> {
	const merged = new Map<string, WorkerRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== RECORD_TYPE) continue;
		const rec = entry.data as Partial<WorkerRecord> | undefined;
		if (!rec || rec.v !== 1 || typeof rec.name !== "string") continue;
		const prev = merged.get(rec.name);
		const next = { ...prev } as WorkerRecord;
		for (const [key, value] of Object.entries(rec)) if (value !== undefined) (next as any)[key] = value;
		merged.set(rec.name, next);
	}
	return merged;
}

/** Workers that were busy when their manager quit. */
export function interruptedRecords(merged: Map<string, WorkerRecord>): WorkerRecord[] {
	return [...merged.values()].filter((r) => r.busy || r.status === "running" || r.status === "starting");
}

export const RESUME_PROMPT =
	"You were interrupted: the pi session that manages you quit while you were working. " +
	"Continue your task from where you stopped. First check what is already done (files, command output) so you do " +
	"not redo or break finished work. When you are done, reply with your final result as before.";

export const INTERRUPTED_NOTE =
	"Note: an earlier attempt at this task was interrupted before it finished. Check what is already done " +
	"before redoing work.";

const INTERRUPTED_TOOL_RESULT =
	"Not run: the session was interrupted (the managing pi quit) before this tool call finished.";

/**
 * Give every unanswered tool call at the end of the session an error result, so the conversation is valid again.
 * Returns the number of results added (0 when nothing needed fixing). Appends through pi's SessionManager.
 */
export function repairSession(sessionFile: string): number {
	const sm = SessionManager.open(sessionFile);
	const branch = sm.getBranch() as EntryLike[] & { message?: any }[];
	let last = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as any;
		if (e.type === "message" && e.message?.role === "assistant") {
			last = i;
			break;
		}
	}
	if (last === -1) return 0;
	const after = branch.slice(last + 1) as any[];
	// Results can only be appended if nothing else the model reads came after the tool calls.
	if (after.some((e) => e.type === "message" && e.message?.role !== "toolResult")) return 0;
	const answered = new Set(after.filter((e) => e.type === "message").map((e) => e.message.toolCallId));
	const calls = ((branch[last] as any).message.content ?? []).filter((b: any) => b?.type === "toolCall");
	let added = 0;
	for (const call of calls) {
		if (answered.has(call.id)) continue;
		sm.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
			isError: true,
			timestamp: Date.now(),
		} as any);
		added++;
	}
	return added;
}

/**
 * True if the worker process from the previous manager still runs (the manager was killed hard, so the worker never
 * got a shutdown). Two pi processes must not write the same session file.
 */
export function oldProcessAlive(pid: number | undefined, name: string): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
		return command.includes(`worker:${name}`);
	} catch {
		return false;
	}
}
