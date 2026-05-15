import fs from "node:fs";

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

const runtimeSource = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const missionControl = fs.readFileSync(new URL("../extensions/missions/ui/mission-control.ts", import.meta.url), "utf8");
const source = `${runtimeSource}\n${missionControl}`;
const dispatchStart = missionControl.indexOf("function dispatchMissionControlInput(data: string, context: MissionControlInputDispatchContext): MissionControlInputDispatchResult {");
const dispatchEnd = dispatchStart >= 0 ? missionControl.indexOf("\n}\n\nexport async function openMissionControl", dispatchStart) : -1;
const dispatchBody = dispatchStart >= 0 && dispatchEnd > dispatchStart ? missionControl.slice(dispatchStart, dispatchEnd) : "";

assert(source.includes("function fitToViewport"), "Mission Control must fit rendered lines to the viewport");
assert(source.includes("function panelLines") && source.includes('panelLines(section.title') && source.includes('panelLines("Mission Summary"'), "Mission Control must render boxed overview/detail sections");
assert(source.includes("clipLine") && source.includes("exactPadLineToWidth"), "Mission Control must clip/pad for responsive terminal widths");
assert(source.includes("limitedPanelLines") && source.includes("outputScrollOffset"), "Detail output must be bounded and scrollable");
assert(source.includes("loadMissionControlViewModel(cwd") && source.includes("vm.sections"), "Mission Control must load and render the shared multi-mission view model");
assert(source.includes('includeClearedCompleted: Boolean(targetMissionId)'), "Targeted detail should be able to show a cleared completed mission");
assert(source.includes('section.id === "completed" ? section.missions.slice') === false, "Completed missions must not be silently truncated in the overview");

for (const expected of [
	"Overview: ↑/↓ or j/k moves selection · enter opens detail",
	"Detail: b or escape returns to overview",
	"Global: r refreshes artifacts · q quits Mission Control",
	"Mission Control is read-only",
]) {
	assert(source.includes(expected), `help missing: ${expected}`);
}

assert(dispatchBody.length > 0, "dispatchMissionControlInput body missing");
assert(dispatchBody.includes('data === "q"') && dispatchBody.includes("context.close();"), "q must close Mission Control");
assert(dispatchBody.includes('matchesKey(data, "escape")'), "escape handling missing");
assert(dispatchBody.includes('matchesKey(data, "enter") && context.view.mode === "overview"'), "enter must open detail from overview");
assert(dispatchBody.includes('data === "b" && context.view.mode === "detail"'), "b must return from detail to overview");
assert(dispatchBody.includes('data === "r"') && dispatchBody.includes("context.requestRender();"), "r must refresh by requesting render");
assert(dispatchBody.includes('data === "g"') && dispatchBody.includes('data === "G"'), "detail top/bottom keys missing");
assert(!dispatchBody.includes("ctx.ui.confirm") && !dispatchBody.includes("context.ctx.ui.confirm"), "dispatch path must not use ctx.ui.confirm");
assert(!dispatchBody.includes("executeRunnerCommand") && !dispatchBody.includes("clearCompletedMissions") && !dispatchBody.includes("sendUserMessage"), "read-only dispatch must not trigger mutation commands");

assert(source.includes("ctx.ui.custom") && source.includes("overlay: true") && source.includes('width: "100%"') && source.includes('maxHeight: "100%"'), "Mission Control must open as a full overlay");
assert(source.includes("setInterval") && source.includes("MISSION_CONTROL_POLL_MS") && source.includes("tui.requestRender()"), "Mission Control must refresh while open");
assert(source.includes("clearInterval(poll)") && source.includes("done(undefined);"), "Mission Control must clean up polling and release the UI");
assert(source.includes('setStatus("missions", undefined') && source.includes("function updateWidget"), "status widget stale-state clearing must remain present");

console.log("F5 Mission Control read-only UX regression validation passed.");
