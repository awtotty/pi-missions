import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const runtimeSource = fs.readFileSync(path.join(repoRoot, "extensions", "missions", "runtime-extension.ts"), "utf8");
const missionControlSource = fs.readFileSync(path.join(repoRoot, "extensions", "missions", "ui", "mission-control.ts"), "utf8");
const source = `${runtimeSource}\n${missionControlSource}`;

const checks = [
	["DETAIL_OUTPUT_VIEW_MODEL", source.includes("MissionControlOutputView") && source.includes("mission.detailOutput")],
	["OUTPUT_LABEL_PANEL", source.includes("mission.detailOutput.label") && source.includes("limitedPanelLines(mission.detailOutput.label")],
	["SECONDARY_OUTPUT_LABELS", source.includes("output.secondary") && source.includes('`--- ${item.label} ---`')],
	["NO_OUTPUT_FALLBACK", source.includes('"No output available."')],
	["DETAIL_SCROLL_KEYS", source.includes('data === "g"') && source.includes('data === "G"') && source.includes("missionControlScrollDelta")],
	["ACTIVITY_REMAINS_AVAILABLE_OUTSIDE_OVERLAY", source.includes("missionActivityViewModel") && source.includes("event-log.jsonl")],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
	console.error("F4 Mission Control read-only activity/output validation failed:");
	for (const [id] of failed) console.error(`- [${id}] missing`);
	process.exit(1);
}

console.log("F4 Mission Control read-only activity/output validation passed.");
for (const [id] of checks) console.log(`- [${id}] ok`);
