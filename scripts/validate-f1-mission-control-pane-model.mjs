import fs from "node:fs";

const source = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");

const dispatchStart = source.indexOf("function dispatchMissionControlInput");
const dispatchEnd = source.indexOf("async function openMissionControl", dispatchStart);
const dispatchSource = dispatchStart >= 0 && dispatchEnd > dispatchStart ? source.slice(dispatchStart, dispatchEnd) : "";

const checks = [
	{
		ok: source.includes('type MissionControlPaneId = "features" | "details" | "activity" | "child-output"'),
		error: "Mission Control must define an explicit stable pane id union.",
	},
	{
		ok: source.includes("focusedPane: MissionControlPaneId") && source.includes("scrollOffsets: Record<MissionControlPaneId, number>") && source.includes("viewMode: MissionControlViewMode"),
		error: "Mission Control view state must track focused pane, pane scroll offsets, and view mode.",
	},
	{
		ok: source.includes("function dispatchMissionControlInput") && source.includes("function missionControlInputMoveDelta"),
		error: "Mission Control key handling must be centralized in deterministic dispatch helpers.",
	},
	{
		ok: source.includes('matchedAction.id === "start-resume"') && source.includes("context.close();") && source.includes("setTimeout(() =>") && source.includes("/missions run"),
		error: "Mission Control start/resume must still close the overlay before queueing mission execution.",
	},
	{
		ok: dispatchSource.length > 0 && !dispatchSource.includes("ctx.ui.confirm") && !dispatchSource.includes("ui.confirm"),
		error: "Mission Control input handling must not call modal ctx.ui.confirm.",
	},
	{
		ok: source.includes('missionControlPaneTitle("Features", "features"') && source.includes('missionControlPaneTitle("Details", "details"') && source.includes('missionControlPaneTitle("Progress Log", "activity"') && source.includes('missionControlPaneTitle("Child Output", "child-output"'),
		error: "Mission Control must render focus affordances for all stable panes.",
	},
];

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
	console.error("F1 mission control pane model validation failed:");
	for (const failure of failures) console.error(`- ${failure.error}`);
	process.exit(1);
}

console.log("F1 mission control pane model validation passed.");
