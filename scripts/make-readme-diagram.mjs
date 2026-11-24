/**
 * Generates the README diagram in a light and a dark version from one layout:
 *   docs/assets/how-it-works-light.svg, docs/assets/how-it-works-dark.svg
 *
 *   node scripts/make-readme-diagram.mjs
 *
 * Plain SVG (no fonts, scripts or external resources), so GitHub shows it in an <img>; the README picks the
 * version that matches the reader's theme with <picture>.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1200;
const H = 584;
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const THEMES = {
	light: {
		bg: "#F8FAFC", panel: "#FFFFFF", panelStroke: "#E2E8F0", grid: "#F1F5F9",
		title: "#0F172A", text: "#0F172A", sub: "#475569", muted: "#64748B", line: "#94A3B8",
		you: { fill: "#F1F5F9", stroke: "#64748B" },
		manager: { fill: "#ECFEFF", stroke: "#0891B2", accent: "#0E7490" },
		worker: { fill: "#ECFDF5", stroke: "#059669" },
		region: { fill: "#F0FDF4", stroke: "#34D399", label: "#047857" },
		live: { fill: "#FFFBEB", stroke: "#D97706" },
	},
	dark: {
		bg: "#060A14", panel: "#0B1220", panelStroke: "#1E293B", grid: "#111A2B",
		title: "#F8FAFC", text: "#F1F5F9", sub: "#94A3B8", muted: "#94A3B8", line: "#64748B",
		you: { fill: "#1E293B", stroke: "#94A3B8" },
		manager: { fill: "#0B2A33", stroke: "#22D3EE", accent: "#67E8F9" },
		worker: { fill: "#0A2A20", stroke: "#34D399" },
		region: { fill: "#07181A", stroke: "#10B981", label: "#6EE7B7" },
		live: { fill: "#2A1E08", stroke: "#FBBF24" },
	},
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x, y, s, { size = 13, fill, weight = 400, anchor = "middle" } = {}) =>
	`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

/** A card: rounded box, bold title, one or two lines below. */
function card(t, { x, y, w, h, colors, title, lines = [], accentLine }) {
	const cx = x + w / 2;
	const top = y + h / 2 - (lines.length + (accentLine ? 1 : 0)) * 9 + 4;
	const out = [
		`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>`,
		text(cx, top, title, { size: 16, fill: t.text, weight: 700 }),
	];
	lines.forEach((l, i) => out.push(text(cx, top + 21 + i * 18, l, { size: 12, fill: t.sub })));
	if (accentLine) out.push(text(cx, top + 21 + lines.length * 18, accentLine, { size: 11, fill: colors.accent, weight: 700 }));
	return out.join("\n");
}

function svg(name) {
	const t = THEMES[name];
	const arrow = (id, color) =>
		`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker>`;
	const path = (d, { dash, marker = "a", start } = {}) =>
		`<path d="${d}" fill="none" stroke="${t.line}" stroke-width="2" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""} marker-end="url(#${marker})"${start ? ` marker-start="url(#${marker})"` : ""}/>`;
	const label = (x, y, s, anchor = "middle") => text(x, y, s, { size: 12, fill: t.muted, anchor });

	// Layout
	const you = { x: 40, y: 262, w: 140, h: 64 };
	const manager = { x: 310, y: 246, w: 220, h: 96 };
	const live = { x: 310, y: 412, w: 220, h: 72 };
	const region = { x: 720, y: 132, w: 436, h: 352 };
	const workers = ["reviewing the API", "writing tests", "updating the docs"];
	const wy = (i) => 206 + i * 90;

	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" role="img" aria-labelledby="t d">`,
		`<title id="t">How pi-multi-agent works</title>`,
		`<desc id="d">You chat with your pi, the manager. It sends self-contained tasks to worker pis, which are separate processes with their own context, model and tools, and gets their results back when they are ready. You can also message a worker directly. A live view shows each worker's thinking, tool calls and cost.</desc>`,
		`<defs>${arrow("a", t.line)}<pattern id="g" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="${t.grid}" stroke-width="1"/></pattern></defs>`,
		`<rect width="${W}" height="${H}" fill="${t.bg}"/>`,
		// Title
		`<circle cx="46" cy="43" r="6" fill="${t.manager.stroke}"/>`,
		text(62, 50, "How pi-multi-agent works", { size: 24, fill: t.title, weight: 700, anchor: "start" }),
		text(62, 76, "Your pi hands self-contained tasks to worker pis and keeps talking with you.", {
			size: 14, fill: t.sub, anchor: "start",
		}),
		// Panel with grid
		`<rect x="20" y="102" width="${W - 40}" height="${H - 122}" rx="16" fill="${t.panel}" stroke="${t.panelStroke}"/>`,
		`<rect x="21" y="103" width="${W - 42}" height="${H - 124}" rx="15" fill="url(#g)"/>`,
		// Workers region
		`<rect x="${region.x}" y="${region.y}" width="${region.w}" height="${region.h}" rx="14" fill="${t.region.fill}" stroke="${t.region.stroke}" stroke-width="1.5" stroke-dasharray="7 6"/>`,
		text(region.x + 20, region.y + 28, "WORKERS · separate pi processes", { size: 12, fill: t.region.label, weight: 700, anchor: "start" }),
		text(region.x + 20, region.y + 48, "own context, model and tools · never see your chat", { size: 12, fill: t.sub, anchor: "start" }),
		...workers.map((job, i) =>
			card(t, { x: region.x + 58, y: wy(i), w: 320, h: 62, colors: t.worker, title: `Worker ${"ABC"[i]}`, lines: [job] }),
		),
		// Nodes
		card(t, { ...you, colors: t.you, title: "You", lines: ["chat as usual"] }),
		card(t, { ...manager, colors: t.manager, title: "Your pi", lines: ["the manager"], accentLine: "+ pi-multi-agent" }),
		card(t, { ...live, colors: t.live, title: "Live view", lines: ["widget · /workers · logs"] }),
		// You <-> manager
		path(`M${you.x + you.w + 2} 294H${manager.x - 2}`, { start: true }),
		label(245, 284, "chat"),
		label(245, 314, "never blocked"),
		// You -> a worker directly, above the manager
		path(`M${you.x + you.w / 2} ${you.y - 2}V196H${region.x - 2}`),
		label(425, 186, "talk to a worker directly"),
		label(425, 214, "/worker-send · m in /workers"),
		// Manager -> workers (tasks), workers -> manager (results)
		path(`M${manager.x + manager.w + 2} 276H${region.x - 2}`),
		label(625, 265, "self-contained tasks"),
		path(`M${region.x - 2} 314H${manager.x + manager.w + 2}`, { dash: "8 6" }),
		label(625, 336, "results, when ready"),
		// Workers -> live view -> you
		path(`M${region.x - 2} 448H${live.x + live.w + 2}`, { dash: "2 5" }),
		label(625, 437, "live updates"),
		label(625, 470, "thinking · tools · cost"),
		path(`M${live.x - 2} 448H${you.x + you.w / 2}V${you.y + you.h + 2}`, { dash: "2 5" }),
		label(215, 437, "you watch"),
		// Legend
		...[
			["", "task / message"],
			["8 6", "result"],
			["2 5", "live update"],
		].map(([dash, name], i, items) => {
			// Same gap between items: each takes a 44px line sample, 12px space and its text (~7.3px per character).
			const width = (s) => 56 + s.length * 7.3;
			const x = 640 + items.slice(0, i).reduce((sum, [, n]) => sum + width(n) + 36, 0);
			return `${path(`M${x} 526H${x + 44}`, { dash })}${text(x + 56, 530, name, { size: 12, fill: t.muted, anchor: "start" })}`;
		}),
		`</svg>`,
	];
	return `${parts.join("\n")}\n`;
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets");
mkdirSync(out, { recursive: true });
for (const name of Object.keys(THEMES)) {
	writeFileSync(join(out, `how-it-works-${name}.svg`), svg(name));
	console.log(`wrote docs/assets/how-it-works-${name}.svg`);
}
