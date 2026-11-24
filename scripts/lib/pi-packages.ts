/**
 * Lets test scripts import the extension's modules under plain Node.
 *
 * Inside pi, extensions get pi's own copies of `@earendil-works/*` and `typebox`. Under Node those imports would fail,
 * so this module registers a resolve hook that looks them up in the node_modules of the `pi` on PATH. Import it before you
 * import any extension module (use dynamic `import()` for those, because static imports are hoisted).
 *
 * Override with PI_NODE_MODULES=<the node_modules directory that contains @earendil-works/pi-tui>.
 * Needs Node >= 22.18 (TypeScript type stripping and module.registerHooks).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

function findPiNodeModules(): string {
	if (process.env.PI_NODE_MODULES) return process.env.PI_NODE_MODULES;
	const piBin = execFileSync("sh", ["-c", "command -v pi"]).toString().trim();
	let start = fs.realpathSync(piBin);
	if (fs.readFileSync(piBin, "utf8").startsWith("#!/bin/sh")) {
		// Managed install: the launcher execs install/releases/<version>/node_modules/.bin/pi.
		const agentDir = path.dirname(path.dirname(start));
		const version = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim();
		start = fs.realpathSync(path.join(agentDir, "install", "releases", version, "node_modules", ".bin", "pi"));
	}
	for (let dir = path.dirname(start); dir !== path.dirname(dir); dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "node_modules", "@earendil-works", "pi-tui"))) return path.join(dir, "node_modules");
	}
	throw new Error("Cannot find @earendil-works/pi-tui next to pi; set PI_NODE_MODULES");
}

const piParent = pathToFileURL(`${findPiNodeModules()}/`).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("@earendil-works/") || specifier === "typebox" || specifier.startsWith("typebox/")) {
			return nextResolve(specifier, { ...context, parentURL: piParent });
		}
		return nextResolve(specifier, context);
	},
});

/** file: URL of an extension module, e.g. extensionModule("ui.ts"). */
export function extensionModule(file: string): string {
	return pathToFileURL(path.resolve(import.meta.dirname, "..", "..", "extensions", "multi-agent", file)).href;
}
