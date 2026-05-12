import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = fs.readFileSync(path.join(repoRoot, "extensions", "missions", "runtime-extension.ts"), "utf8");

const checks = [
	["SHIFT_TAB", source.includes('data === "\\u001b[Z"')],
	["PANE_JUMP_KEYS", source.includes('function missionControlPaneJump(data: string)')],
	["SCROLL_KEYS", source.includes('function missionControlScrollDelta(data: string)')],
	["INSPECT_MODE_TOGGLE", source.includes('viewMode === "dashboard" ? "inspect" : "dashboard"')],
	["CONTEXT_FOOTER", source.includes('function missionControlFooter(width: number, view: MissionControlViewState')],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
	console.error("Mission Control navigation validation failed:");
	for (const [id] of failed) console.error(`- [${id}] missing`);
	process.exit(1);
}

console.log("Mission Control navigation validation passed.");
for (const [id] of checks) console.log(`- [${id}] ok`);
