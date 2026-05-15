import fs from "node:fs";

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

const runtimeSource = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const missionControl = fs.readFileSync(new URL("../extensions/missions/ui/mission-control.ts", import.meta.url), "utf8");
const runtime = `${runtimeSource}\n${missionControl}`;
const viewModel = fs.readFileSync(new URL("../extensions/missions/core/mission-control-view-model.ts", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const guide = fs.readFileSync(new URL("../docs/mission-control.md", import.meta.url), "utf8");

const dispatchStart = missionControl.indexOf("function dispatchMissionControlInput(data: string, context: MissionControlInputDispatchContext): MissionControlInputDispatchResult {");
const dispatchEnd = dispatchStart >= 0 ? missionControl.indexOf("\n}\n\nexport async function openMissionControl", dispatchStart) : -1;
const dispatchBody = dispatchStart >= 0 && dispatchEnd > dispatchStart ? missionControl.slice(dispatchStart, dispatchEnd) : "";

assert(viewModel.includes("MISSION_CONTROL_SECTION_ORDER"), "shared view model must define stable section order");
for (const section of ["Blocked / Failed", "Running", "Paused", "Planned", "Completed"]) {
	assert(viewModel.includes(`title: \"${section}\"`) || viewModel.includes(`title: "${section}"`), `view model missing section ${section}`);
	assert(runtime.includes(`panelLines(section.title`), "overview must render sections from the view model");
}

for (const expected of [
	"Mission Control",
	"Read-only overview",
	"Read-only detail",
	"Mission Summary",
	"missionControlMissionSummaryLines",
	"mission.detailOutput.label",
]) assert(runtime.includes(expected), `runtime missing read-only render marker: ${expected}`);

for (const expected of [
	'matchesKey(data, "enter") && context.view.mode === "overview"',
	'data === "b" && context.view.mode === "detail"',
	'matchesKey(data, "escape")',
	'data === "r"',
	'data === "g" && context.view.mode === "detail"',
	'data === "G" && context.view.mode === "detail"',
]) assert(dispatchBody.includes(expected), `dispatch missing navigation key: ${expected}`);

for (const forbidden of [
	"executeRunnerCommand",
	"clearCompletedMissions",
	"mission_start_execution",
	"mission_runner_command",
	"sendUserMessage",
	"ctx.ui.confirm",
	"pause-after-current",
	"cancel-current",
]) assert(!dispatchBody.includes(forbidden), `read-only dispatch must not include mutation/control path: ${forbidden}`);

for (const doc of [readme, guide]) {
	for (const expected of [
		"multi-mission",
		"Blocked / Failed",
		"Running",
		"Paused",
		"Planned",
		"Completed",
		"read-only",
		"main chat",
		"↑ / ↓ or j / k",
		"enter",
		"r",
		"q / esc",
	]) assert(doc.includes(expected), `Mission Control docs missing: ${expected}`);
	assert(!doc.includes("pressing `s`") && !doc.includes("p                   Pause") && !doc.includes("x                   Cancel"), "docs must not advertise Mission Control mutation keys");
}

console.log("F4 Mission Control read-only regression validation passed.");
