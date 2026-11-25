/**
 * Idle cleanup: stop worker processes that nobody reused for a while.
 *
 * A worker that finished its task stays alive (idle) so the manager can give it more work with worker_send. Each idle
 * worker holds a pi process and its memory. After PI_MULTI_AGENT_IDLE_MINUTES (default 10) without a new task, the
 * manager stops the process. The worker stays in the list as `stopped` (idle), with its result, log and session file.
 * A later worker_send revives it on its own session file, so it keeps its context (index.ts).
 *
 * idleSince and shouldReap take the time as a parameter, so scripts/test-idle.ts checks them without processes.
 */

import { fmtDuration } from "./format.ts";
import type { Worker } from "./worker.ts";

export const DEFAULT_IDLE_MINUTES = 10;

export interface IdleConfig {
	/** Idle time before a worker process is stopped; 0 = never. */
	idleMs: number;
	/** Time between idle checks. */
	intervalMs: number;
}

/** PI_MULTI_AGENT_IDLE_MINUTES: minutes (fractions allowed), or 0/off. Unset, empty or invalid: the default. */
export function readIdleConfig(env: Record<string, string | undefined> = process.env): IdleConfig {
	const text = env.PI_MULTI_AGENT_IDLE_MINUTES?.trim().toLowerCase();
	let minutes = DEFAULT_IDLE_MINUTES;
	if (text) {
		if (["off", "false", "no", "none", "disabled", "never"].includes(text)) minutes = 0;
		else {
			const n = Number(text);
			if (Number.isFinite(n) && n >= 0) minutes = n;
		}
	}
	const idleMs = Math.round(minutes * 60_000);
	// Check about 10 times per idle period: at most every 30 s, at least every 1 s.
	const intervalMs = idleMs > 0 ? Math.min(30_000, Math.max(1000, Math.round(idleMs / 10))) : 0;
	return { idleMs, intervalMs };
}

export function describeIdleConfig(cfg: IdleConfig): string {
	return cfg.idleMs
		? `idle cleanup: worker processes stop after ${fmtDuration(cfg.idleMs)} without a task; worker_send revives them with their context`
		: "idle cleanup: off (PI_MULTI_AGENT_IDLE_MINUTES=0)";
}

/** When the worker last stopped working: end of its last task, or its start if it never had one. */
export function idleSince(w: Worker): number {
	return w.taskFinishedAt ?? w.createdAt;
}

/**
 * True if the worker's process should be stopped now. Never while it works, starts, stops, has queued messages,
 * waits for a dialog, or while someone waits on it (`held`).
 */
export function shouldReap(w: Worker, now: number, cfg: IdleConfig, held = false): boolean {
	if (!cfg.idleMs || held) return false;
	if (!w.alive || w.busy || w.stopping || w.status === "starting") return false;
	if (w.queued > 0 || w.dialogs > 0) return false;
	return now - idleSince(w) >= cfg.idleMs;
}
