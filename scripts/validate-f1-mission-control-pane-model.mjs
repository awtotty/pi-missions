import fs from "node:fs";

const runtimeSource = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const missionControlSource = fs.readFileSync(new URL("../extensions/missions/ui/mission-control.ts", import.meta.url), "utf8");
const source = `${runtimeSource}\n${missionControlSource}`;

const dispatchStart = missionControlSource.indexOf("function dispatchMissionControlInput");
const dispatchEnd = missionControlSource.indexOf("export async function openMissionControl", dispatchStart);
const dispatchSource = dispatchStart >= 0 && dispatchEnd > dispatchStart ? missionControlSource.slice(dispatchStart, dispatchEnd) : "";

const checks = [
	{
		ok: source.includes("loadMissionControlViewModel") && source.includes("MissionControlViewModel") && source.includes("MissionControlMissionView"),
		error: "Mission Control must render from the shared read-only view model.",
	},
	{
		ok: source.includes('mode: "overview"') && source.includes('view.mode = "detail"') && source.includes("outputScrollOffset"),
		error: "Mission Control view state must track overview/detail mode and detail output scroll offset.",
	},
	{
		ok: source.includes("function dispatchMissionControlInput") && source.includes("function missionControlInputMoveDelta") && source.includes("function missionControlScrollDelta"),
		error: "Mission Control key handling must be centralized in deterministic dispatch helpers.",
	},
	{
		ok: dispatchSource.length > 0 && !dispatchSource.includes("ctx.ui.confirm") && !dispatchSource.includes("ui.confirm"),
		error: "Mission Control input handling must not call modal ctx.ui.confirm.",
	},
	{
		ok: dispatchSource.length > 0
			&& !dispatchSource.includes('command: "start"')
			&& !dispatchSource.includes('command: "resume"')
			&& !dispatchSource.includes('command: "pause-after-current"')
			&& !dispatchSource.includes('command: "cancel-current-child"')
			&& !dispatchSource.includes('command: "retry-feature"')
			&& !dispatchSource.includes('clearCompletedMissions'),
		error: "Mission Control overlay input must remain read-only and not dispatch mutation controls.",
	},
	{
		ok: source.includes('panelLines(section.title') && source.includes('panelLines("Mission Summary"') && source.includes("mission.detailOutput.label"),
		error: "Mission Control must render boxed overview sections, a detail summary, and labeled output.",
	},
];

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
	console.error("F1 mission control read-only model validation failed:");
	for (const failure of failures) console.error(`- ${failure.error}`);
	process.exit(1);
}

console.log("F1 mission control read-only model validation passed.");
