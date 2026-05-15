import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = fs.readFileSync(path.join(repoRoot, "extensions", "missions", "runtime-extension.ts"), "utf8");
const dispatchStart = source.indexOf("function dispatchMissionControlInput");
const dispatchEnd = source.indexOf("async function openMissionControl", dispatchStart);
const dispatchSource = dispatchStart >= 0 && dispatchEnd > dispatchStart ? source.slice(dispatchStart, dispatchEnd) : "";

const checks = [
	["OVERVIEW_DETAIL_MODES", source.includes('mode: "overview"') && source.includes('view.mode = "detail"') && source.includes('view.mode = "overview"')],
	["MOVE_KEYS", source.includes('data === "k"') && source.includes('data === "j"') && source.includes('matchesKey(data, "up")') && source.includes('matchesKey(data, "down")')],
	["ENTER_OPENS_DETAIL", dispatchSource.includes('matchesKey(data, "enter") && context.view.mode === "overview"')],
	["BACK_ESCAPE", dispatchSource.includes('data === "b" && context.view.mode === "detail"') && dispatchSource.includes('matchesKey(data, "escape")')],
	["REFRESH_AND_QUIT", dispatchSource.includes('data === "r"') && dispatchSource.includes('data === "q"') && dispatchSource.includes('context.close();')],
	["DETAIL_SCROLL", source.includes('function missionControlScrollDelta(data: string)') && dispatchSource.includes('data === "g"') && dispatchSource.includes('data === "G"')],
	["READ_ONLY_NO_MUTATION_KEYS", !dispatchSource.includes('executeRunnerCommand') && !dispatchSource.includes('clearCompletedMissions') && !dispatchSource.includes('openOrSwitchMissionOrchestratorSession')],
	["CONTEXT_FOOTER", source.includes('function missionControlFooter(width: number, view: MissionControlViewState') && source.includes('read-only')],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
	console.error("Mission Control read-only navigation validation failed:");
	for (const [id] of failed) console.error(`- [${id}] missing`);
	process.exit(1);
}

console.log("Mission Control read-only navigation validation passed.");
for (const [id] of checks) console.log(`- [${id}] ok`);
