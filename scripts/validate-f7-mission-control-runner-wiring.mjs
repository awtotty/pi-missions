import fs from "node:fs";

const source = fs.readFileSync(new URL("../extensions/missions/index.ts", import.meta.url), "utf8");

const checks = [
	{
		ok: source.includes('panelLines("Runner & Orchestrator", missionControlPlaneLines(mission), width)'),
		error: "Mission Control must render a Runner & Orchestrator panel.",
	},
	{
		ok: source.includes("Runner lock:") && source.includes("heartbeat"),
		error: "Mission Control must surface runner lock and heartbeat information.",
	},
	{
		ok: source.includes("Current feature attempt:") && source.includes("Current validation attempt:"),
		error: "Mission Control must surface current worker/validator attempt counters.",
	},
	{
		ok: source.includes("Official orchestrator session:") && source.includes("openOrSwitchMissionOrchestratorSession"),
		error: "Mission Control must expose/open the official orchestrator session.",
	},
	{
		ok: source.includes('executeRunnerCommand({ command: "pause-after-current"')
			&& source.includes('executeRunnerCommand({ command: "start"')
			&& source.includes('executeRunnerCommand({ command: "cancel-current-child"'),
		error: "Mission Control actions must route through executeRunnerCommand API.",
	},
	{
		ok: source.includes("dispose: () => {") && source.includes("finalize();") && source.includes("done(undefined);"),
		error: "Mission Control disposal must finalize and release control back to the interactive session.",
	},
	{
		ok: source.includes('panelLines("Child Output", childOutputLines(run), width)') && source.includes("transcript stream"),
		error: "Mission Control must show child transcript stream output.",
	},
];

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
	console.error("F7 mission control wiring validation failed:");
	for (const failure of failures) console.error(`- ${failure.error}`);
	process.exit(1);
}

console.log("F7 mission control wiring validation passed.");
