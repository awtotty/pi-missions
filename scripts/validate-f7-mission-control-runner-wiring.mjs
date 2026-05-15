import fs from "node:fs";

const source = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const dispatchStart = source.indexOf("function dispatchMissionControlInput");
const dispatchEnd = source.indexOf("async function openMissionControl", dispatchStart);
const dispatchSource = dispatchStart >= 0 && dispatchEnd > dispatchStart ? source.slice(dispatchStart, dispatchEnd) : "";

const checks = [
	{
		ok: source.includes("function executeRunnerCommand") && source.includes('if (input.command === "pause-after-current")') && source.includes('if (input.command === "cancel-current-child")'),
		error: "Deterministic runner command routing must remain available outside Mission Control.",
	},
	{
		ok: source.includes("startMissionInBackground") && source.includes("Mission execution started in background"),
		error: "Background mission execution behavior must remain present.",
	},
	{
		ok: source.includes("openOrSwitchMissionOrchestratorSession") && source.includes("runningMissionOrchestratorContext"),
		error: "Main-chat/orchestrator session intervention support must remain present.",
	},
	{
		ok: dispatchSource.length > 0 && !dispatchSource.includes("executeRunnerCommand") && !dispatchSource.includes("openOrSwitchMissionOrchestratorSession"),
		error: "Read-only Mission Control must not route runner/orchestrator mutations from overlay input.",
	},
	{
		ok: source.includes("dispose: () => {") && source.includes("finalize();") && source.includes("done(undefined);"),
		error: "Mission Control disposal must finalize and release control back to the interactive session.",
	},
	{
		ok: source.includes("mission.detailOutput.label") && source.includes("missionControlOutputLines") && source.includes("transcript"),
		error: "Mission Control detail must show labeled child/relevant output from the view model.",
	},
];

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
	console.error("F7 mission control read-only wiring validation failed:");
	for (const failure of failures) console.error(`- ${failure.error}`);
	process.exit(1);
}

console.log("F7 mission control read-only wiring validation passed.");
