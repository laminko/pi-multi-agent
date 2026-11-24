/**
 * Health checks: the manager follows up on running workers.
 *
 * While at least one worker is busy, the manager checks every busy worker every PI_MULTI_AGENT_HEALTH_INTERVAL seconds
 * (default 10). A check costs no model tokens: one `get_state` RPC per worker (the heartbeat: does the process still
 * answer?) plus what the worker already tracks (time of its last event, open dialogs, repeated tool calls).
 *
 * Verdicts, worst first:
 *   unresponsive  the process did not answer `maxPingFailures` heartbeats in a row
 *   waiting       a dialog waits for you: shown, never alerted (only you can answer it)
 *   looping       the same tool call with the same arguments `loopRepeats` times in a row
 *   quiet         no event for PI_MULTI_AGENT_STALL_SECONDS (default 180)
 *
 * On a new problem the manager LLM gets an alert (index.ts), and again each time the problem has lasted about twice as
 * long, so a worker that stays stuck is followed up without flooding the conversation.
 *
 * assessHealth and updateHealth take the time as a parameter, so scripts/test-health.ts checks them without processes.
 */

import { fmtDuration, oneLine, statusTable } from "./format.ts";
import type { HealthState, Worker } from "./worker.ts";

export interface HealthConfig {
	/** Time between checks; 0 = health checks off. */
	intervalMs: number;
	/** No event for this long = quiet; 0 = quiet detection off. */
	stallMs: number;
	/** Heartbeat reply timeout. */
	pingTimeoutMs: number;
	/** Unanswered heartbeats in a row before a worker counts as unresponsive. */
	maxPingFailures: number;
	/** Identical tool calls in a row that count as a loop; 0 = off. */
	loopRepeats: number;
}

export const DEFAULT_INTERVAL_SECONDS = 10;
export const DEFAULT_STALL_SECONDS = 180;
/** Repeated alerts for one ongoing problem come at least this far apart. */
const MIN_REALERT_MS = 60_000;

/** Seconds from an env var: a number >= 0, or off/false/no = 0. Unset, empty or invalid: the default. */
function envSeconds(raw: string | undefined, fallback: number): number {
	const text = raw?.trim().toLowerCase();
	if (!text) return fallback;
	if (["off", "false", "no", "none", "disabled"].includes(text)) return 0;
	const n = Number(text);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readHealthConfig(env: Record<string, string | undefined> = process.env): HealthConfig {
	const interval = envSeconds(env.PI_MULTI_AGENT_HEALTH_INTERVAL, DEFAULT_INTERVAL_SECONDS);
	const stall = envSeconds(env.PI_MULTI_AGENT_STALL_SECONDS, DEFAULT_STALL_SECONDS);
	const intervalMs = interval > 0 ? Math.max(1000, Math.round(interval * 1000)) : 0;
	return {
		intervalMs,
		stallMs: Math.round(stall * 1000),
		// A live pi answers get_state in milliseconds, even mid-task. At most one interval, so checks keep their pace.
		pingTimeoutMs: Math.min(5000, intervalMs || 5000),
		maxPingFailures: 3,
		loopRepeats: 5,
	};
}

/** One line about the settings, for worker_status and the alerts. */
export function describeHealthConfig(cfg: HealthConfig): string {
	if (!cfg.intervalMs) return "health checks: off (PI_MULTI_AGENT_HEALTH_INTERVAL=0)";
	const quiet = cfg.stallMs ? `quiet after ${fmtDuration(cfg.stallMs)} without output` : "quiet detection off";
	return (
		`health checks: every ${fmtDuration(cfg.intervalMs)} while workers run · ${quiet} · ` +
		`not answering after ${cfg.maxPingFailures} unanswered checks · loop at ${cfg.loopRepeats} identical tool calls in a row`
	);
}

// ------------------------------------------------------------------ heartbeat

/** One heartbeat: `get_state` with a timeout. Updates w.health and never throws. Skipped while the last one is pending. */
export async function heartbeat(w: Worker, cfg: HealthConfig, now: () => number = Date.now): Promise<void> {
	const h = w.health; // a new task replaces w.health; a late reply then only touches the old object
	if (h.checking) return;
	h.checking = true;
	const sentAt = now();
	h.lastCheckAt = sentAt;
	try {
		const state = await w.ping(cfg.pingTimeoutMs);
		h.lastReplyAt = now();
		h.failures = 0;
		h.firstFailureAt = undefined;
		h.remote = {
			isStreaming: state?.isStreaming,
			isCompacting: state?.isCompacting,
			pendingMessageCount: state?.pendingMessageCount,
		};
	} catch {
		if (w.alive) {
			h.failures++;
			h.firstFailureAt ??= sentAt;
		}
	} finally {
		h.checking = false;
	}
}

// ------------------------------------------------------------------ verdict

export interface HealthVerdict {
	state: HealthState;
	/** Start of the problem; a different start is a different problem. */
	since?: number;
	detail: string;
}

const OK: HealthVerdict = { state: "ok", detail: "" };

/** What the worker looks like now. Pure: reads the worker, changes nothing. */
export function assessHealth(w: Worker, now: number, cfg: HealthConfig): HealthVerdict {
	if (!w.busy) return OK;
	const h = w.health;
	const activity = oneLine(w.activity, 120);
	if (h.failures >= cfg.maxPingFailures) {
		return {
			state: "unresponsive",
			since: h.firstFailureAt,
			detail: `its process (pid ${w.pid ?? "?"}) did not answer the last ${h.failures} status checks; last activity: ${activity}`,
		};
	}
	if (w.dialogs > 0) {
		return { state: "waiting", since: w.dialogSince, detail: `a dialog waits for your answer: ${oneLine(w.dialogTitle, 120)}` };
	}
	if (cfg.loopRepeats > 0 && w.repeatCount >= cfg.loopRepeats) {
		return {
			state: "looping",
			since: w.repeatSince,
			detail: `it made the same tool call ${w.repeatCount} times in a row: ${oneLine(w.repeatLabel, 120)}`,
		};
	}
	const quietMs = now - w.lastEventAt;
	if (cfg.stallMs > 0 && quietMs >= cfg.stallMs) {
		let detail = `no output for ${fmtDuration(quietMs)}; now: ${activity}`;
		const r = h.remote;
		if (r?.isStreaming === false && !r.isCompacting) {
			detail += "; pi in the worker reports no run in progress, so the task may have ended without its final event";
		} else if (h.lastReplyAt && h.failures === 0) {
			detail += "; its process still answers status checks";
		}
		return { state: "quiet", since: w.lastEventAt, detail };
	}
	return OK;
}

export type HealthAction =
	| { kind: "none" }
	/** The state changed without an alert ("waiting" for a dialog). */
	| { kind: "changed" }
	| { kind: "alert"; repeat: boolean }
	| { kind: "recovered"; previous: HealthState; alerted: boolean };

const NONE: HealthAction = { kind: "none" };

/** Next alert for an ongoing problem: when it has lasted about twice as long (at least one stall period, min 60 s). */
function nextAlertAt(since: number, now: number, cfg: HealthConfig): number {
	return now + Math.max(now - since, cfg.stallMs, MIN_REALERT_MS);
}

/** Apply a verdict to w.health and say what the manager should do about it. */
export function updateHealth(w: Worker, verdict: HealthVerdict, now: number, cfg: HealthConfig): HealthAction {
	const h = w.health;
	if (verdict.state === "ok") {
		if (h.state === "ok") return NONE;
		const action: HealthAction = { kind: "recovered", previous: h.state, alerted: h.episodeAlerts > 0 };
		h.state = "ok";
		h.since = undefined;
		h.detail = "";
		h.episodeAlerts = 0;
		h.nextAlertAt = undefined;
		return action;
	}
	const since = verdict.since ?? now;
	if (verdict.state !== h.state || since !== h.since) {
		// A new problem.
		h.state = verdict.state;
		h.since = since;
		h.detail = verdict.detail;
		h.episodeAlerts = 0;
		h.nextAlertAt = undefined;
		if (verdict.state === "waiting") return { kind: "changed" };
		h.alerts++;
		h.episodeAlerts++;
		h.nextAlertAt = nextAlertAt(since, now, cfg);
		return { kind: "alert", repeat: false };
	}
	h.detail = verdict.detail;
	if (h.nextAlertAt !== undefined && now >= h.nextAlertAt) {
		h.alerts++;
		h.episodeAlerts++;
		h.nextAlertAt = nextAlertAt(since, now, cfg);
		return { kind: "alert", repeat: true };
	}
	return NONE;
}

// ------------------------------------------------------------------ text for the manager LLM

const STATE_TITLE: Record<HealthState, string> = {
	ok: "ok",
	quiet: "quiet",
	unresponsive: "not answering",
	looping: "in a loop",
	waiting: "waiting for you",
};

export function healthTitle(state: HealthState): string {
	return STATE_TITLE[state];
}

/** First line of an alert, e.g. `Worker "build" may be stuck (quiet): no output for 3m02s; now: bash $ npm run dev.` */
export function healthHeadline(w: Worker, repeat = false): string {
	return `Worker "${w.name}" ${repeat ? "is still" : "may be"} stuck (${STATE_TITLE[w.health.state]}): ${w.health.detail}.`;
}

/** What the manager can do about the current problem, one "- " line each. */
export function healthAdvice(w: Worker): string[] {
	const name = JSON.stringify(w.name);
	switch (w.health.state) {
		case "unresponsive":
			return [
				`- Its process does not answer, so messages and aborts will not reach it. Kill it with worker_stop (name ${name}, mode "kill"), then spawn a new worker for the rest of the task; its log shows what it already did.`,
			];
		case "looping":
			return [
				`- Look at its recent tool calls with worker_status ${name}.`,
				`- Steer it with worker_send (mode "steer"): say what goes wrong and what to try instead. Each call ends, so the steer message arrives.`,
				`- If it keeps looping, abort the task with worker_stop (mode "abort").`,
			];
		default:
			return [
				`- Look closer with worker_status ${name}: latest thinking and recent tool calls.`,
				"- If the current step is legitimately long (a big build or test run, a slow model), leave it running. You get another alert if it stays like this.",
				`- A hung tool call (a server started in the foreground, a command waiting for input) blocks steering, because steer messages arrive only after the current step. Abort with worker_stop (mode "abort"), then give corrected instructions with worker_send.`,
				`- If an abort does not help either, kill it (worker_stop, mode "kill") and spawn a new worker.`,
			];
	}
}

/** Headline and advice, for a worker_wait that stopped early because of this worker. */
export function healthFollowUp(w: Worker): string {
	return [healthHeadline(w), "What to do:", ...healthAdvice(w)].join("\n");
}

/** The alert message for the manager LLM. The first line is the headline (the TUI shows it as the header). */
export function healthAlertText(w: Worker, cfg: HealthConfig, repeat: boolean): string {
	return [
		healthHeadline(w, repeat),
		"",
		statusTable([w], { legend: false }),
		"",
		`(${describeHealthConfig(cfg)})`,
		"",
		"What to do:",
		...healthAdvice(w),
		"Then tell the user in one or two sentences what you found and what you did.",
	].join("\n");
}
