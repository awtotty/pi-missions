import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = fs.readFileSync(path.join(repoRoot, "extensions", "missions", "runtime-extension.ts"), "utf8");

const checks = [
	["CHILD_OUTPUT_MODE_TYPE", source.includes('type ChildOutputMode = "summary" | "raw" | "stderr";')],
	["CHILD_OUTPUT_MODE_TOGGLE_KEY", source.includes('if (data === "o")') && source.includes("cycleChildOutputMode")],
	["ACTIVITY_SELECTION_STATE", source.includes("selectedActivityIndexFromEnd")],
	["ACTIVITY_ROWS_MARKER", source.includes('const marker = index === window.events.length - 1 - selected ? "▸" : " ";')],
	["DETAILS_ACTIVITY_INSPECT", source.includes("Activity event:") && source.includes("eventDataSummary(activityEvent)")],
	["CHILD_OUTPUT_MODE_RENDER", source.includes("View mode: ") && source.includes("childOutputRawLines")],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
	console.error("F4 Mission Control activity/output validation failed:");
	for (const [id] of failed) console.error(`- [${id}] missing`);
	process.exit(1);
}

console.log("F4 Mission Control activity/output validation passed.");
for (const [id] of checks) console.log(`- [${id}] ok`);
